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

#include <algorithm>
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
std::map<std::string, ParvaneE2EGroupSession *> g_ownGroups;   // groupId → своя исходящая
std::map<std::string, ParvaneE2EInboundGroup *> g_inGroups;    // "group|senderId" → входящая
std::map<std::string, std::uint64_t> g_ownGroupEpoch;          // groupId → эпоха своей исходящей
std::map<std::string, std::uint64_t> g_inGroupEpoch;           // "group|senderId" → эпоха входящей
std::map<std::string, std::vector<std::string>> g_groupRecipients; // groupId → последний набор SKDM
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
std::string groupRecipientsPath() { return g_storeDir + "/grecip.json"; }

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

void saveGroupRecipients() {
    if (g_storeDir.empty()) {
        return;
    }
    json j = json::object();
    for (const auto &[group, recipients] : g_groupRecipients) {
        j[group] = recipients;
    }
    writeFile(groupRecipientsPath(), j.dump());
}

void loadGroupRecipients() {
    if (g_storeDir.empty()) {
        return;
    }
    const auto raw = readFile(groupRecipientsPath());
    if (raw.empty()) {
        return;
    }
    const auto j = json::parse(raw, nullptr, false);
    if (!j.is_object()) {
        return;
    }
    for (auto it = j.begin(); it != j.end(); ++it) {
        if (it.value().is_array()) {
            g_groupRecipients[it.key()] = it.value().get<std::vector<std::string>>();
        }
    }
}

std::uint64_t nowMs() {
    return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
}
std::string epochsPath() { return g_storeDir + "/gepoch.json"; }
void saveEpochs() {
    if (g_storeDir.empty()) {
        return;
    }
    json j;
    j["own"] = json::object();
    j["in"] = json::object();
    for (const auto &[k, v] : g_ownGroupEpoch) {
        j["own"][k] = v;
    }
    for (const auto &[k, v] : g_inGroupEpoch) {
        j["in"][k] = v;
    }
    writeFile(epochsPath(), j.dump());
}
void loadEpochs() {
    if (g_storeDir.empty()) {
        return;
    }
    const auto raw = readFile(epochsPath());
    if (raw.empty()) {
        return;
    }
    auto j = json::parse(raw, nullptr, false);
    if (!j.is_object()) {
        return;
    }
    if (j.contains("own") && j["own"].is_object()) {
        for (auto it = j["own"].begin(); it != j["own"].end(); ++it) {
            if (it.value().is_number_unsigned()) {
                g_ownGroupEpoch[it.key()] = it.value().get<std::uint64_t>();
            }
        }
    }
    if (j.contains("in") && j["in"].is_object()) {
        for (auto it = j["in"].begin(); it != j["in"].end(); ++it) {
            if (it.value().is_number_unsigned()) {
                g_inGroupEpoch[it.key()] = it.value().get<std::uint64_t>();
            }
        }
    }
}

std::string ownGroupPath(const std::string &groupId) {
    return g_storeDir + "/gout_" + hexName(groupId) + ".json";
}
std::string inGroupPath(const std::string &key) {
    return g_storeDir + "/gin_" + hexName(key) + ".json";
}
void persistOwnGroup(const std::string &groupId, ParvaneE2EGroupSession *g) {
    if (g_storeDir.empty() || !g) {
        return;
    }
    writeFile(ownGroupPath(groupId), take(parvane_e2e_group_pickle(g)));
}
void persistInGroup(const std::string &key, ParvaneE2EInboundGroup *g) {
    if (g_storeDir.empty() || !g) {
        return;
    }
    writeFile(inGroupPath(key), take(parvane_e2e_inbound_group_pickle(g)));
}

// Своя исходящая group-сессия: память → диск (создаётся вызывающим при отсутствии).
ParvaneE2EGroupSession *getOwnGroup(const std::string &groupId) {
    auto it = g_ownGroups.find(groupId);
    if (it != g_ownGroups.end()) {
        return it->second;
    }
    if (!g_storeDir.empty()) {
        const auto pickle = readFile(ownGroupPath(groupId));
        if (!pickle.empty()) {
            if (auto *g = parvane_e2e_group_from_pickle(pickle.c_str())) {
                g_ownGroups[groupId] = g;
                return g;
            }
        }
    }
    return nullptr;
}

void rotateOwnGroupLocked(const std::string &groupId) {
    auto it = g_ownGroups.find(groupId);
    if (it != g_ownGroups.end()) {
        if (it->second) {
            parvane_e2e_group_free(it->second);
        }
        g_ownGroups.erase(it);
    }
    if (!g_storeDir.empty()) {
        std::error_code ec;
        std::filesystem::remove(ownGroupPath(groupId), ec);
    }
}

// Входящая group-сессия по ключу "group|senderIdentity": память → диск.
ParvaneE2EInboundGroup *getInGroup(const std::string &key) {
    auto it = g_inGroups.find(key);
    if (it != g_inGroups.end()) {
        return it->second;
    }
    if (!g_storeDir.empty()) {
        const auto pickle = readFile(inGroupPath(key));
        if (!pickle.empty()) {
            if (auto *g = parvane_e2e_inbound_group_from_pickle(pickle.c_str())) {
                g_inGroups[key] = g;
                return g;
            }
        }
    }
    return nullptr;
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
            loadEpochs();
            loadGroupRecipients();
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
        // ~6с ретраев: при «холодном старте» обоих (оба только вошли и сразу пишут
        // друг другу) получатель мог ещё не опубликовать prekeys — короткое окно
        // приводило к «E2E не удался» на первом контакте. Ждём публикации пира.
        for (int attempt = 0; attempt < 12; ++attempt) {
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
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
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
        // pre-key: отправитель шлёт prekey, ПОКА не получил ответ. Если сессия с
        // этим identity уже есть (в т.ч. подгруженная с диска) — расшифровываем
        // ЕЮ (без повторного расхода one-time — он уже израсходован на 1-м prekey).
        // Только если сессии нет / не подошла — создаём новую inbound.
        if (auto *existing = getSession(senderId)) {
            const auto pt = take(parvane_e2e_decrypt(existing, 0, ct.c_str()));
            if (!pt.empty()) {
                persistSession(senderId, existing);
                return b64d(pt);
            }
        }
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

std::string myIdentity() {
    std::lock_guard<std::mutex> lk(g_mu);
    return g_identityB64;
}

// (под g_mu) Своя исходящая для группы + её эпоха. Создаёт при отсутствии, выдавая
// СТРОГО бОльшую эпоху, чем любая прежняя (nowMs, либо old+1 при совпадении) — это
// делает ротацию монотонной: новый ключ всегда «новее» для получателей.
ParvaneE2EGroupSession *ensureOwnGroupLocked(const std::string &groupId) {
    auto *g = getOwnGroup(groupId);
    if (g) {
        return g;
    }
    g = parvane_e2e_group_new();
    if (!g) {
        return nullptr;
    }
    g_ownGroups[groupId] = g;
    std::uint64_t ep = nowMs();
    auto it = g_ownGroupEpoch.find(groupId);
    if (it != g_ownGroupEpoch.end() && it->second >= ep) {
        ep = it->second + 1;
    }
    g_ownGroupEpoch[groupId] = ep;
    persistOwnGroup(groupId, g);
    saveEpochs();
    return g;
}

std::string groupSessionKey(const std::string &groupId) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (!g_account || groupId.empty()) {
        return {};
    }
    auto *g = ensureOwnGroupLocked(groupId);
    return g ? take(parvane_e2e_group_session_key(g)) : std::string{};
}

std::uint64_t groupEpoch(const std::string &groupId) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (!g_account || groupId.empty()) {
        return 0;
    }
    ensureOwnGroupLocked(groupId); // гарантирует наличие эпохи
    auto it = g_ownGroupEpoch.find(groupId);
    return it == g_ownGroupEpoch.end() ? 0 : it->second;
}

void groupRotate(const std::string &groupId) {
    if (groupId.empty()) {
        return;
    }
    std::lock_guard<std::mutex> lk(g_mu);
    // Сбрасываем свою исходящую (память + файл) — следующая отправка создаст свежую
    // сессию с НОВЫМ ключом и бОльшей эпохой; удалённый участник его не получит.
    rotateOwnGroupLocked(groupId);
    // Эпоху НЕ трогаем: ensureOwnGroupLocked при пересоздании выставит строго
    // большую (nowMs или old+1), так что новый ключ заведомо новее старого.
}

bool groupSyncRecipients(const std::string &groupId, const std::vector<std::string> &members) {
    if (groupId.empty()) {
        return false;
    }
    auto recipients = members;
    recipients.erase(std::remove_if(recipients.begin(), recipients.end(), [](const auto &member) {
        return member.empty() || member == g_self;
    }), recipients.end());
    std::sort(recipients.begin(), recipients.end());
    recipients.erase(std::unique(recipients.begin(), recipients.end()), recipients.end());

    std::lock_guard<std::mutex> lk(g_mu);
    const auto previous = g_groupRecipients.find(groupId);
    bool rotate = false;
    if (previous == g_groupRecipients.end()) {
        // Без сохранённого baseline старый pickle мог быть раздан уже
        // исключённым участникам: одноразовая безопасная миграция.
        rotate = getOwnGroup(groupId) != nullptr;
    } else {
        rotate = std::any_of(
            previous->second.begin(),
            previous->second.end(),
            [&recipients](const auto &member) {
                return !std::binary_search(recipients.begin(), recipients.end(), member);
            });
    }
    if (rotate) {
        rotateOwnGroupLocked(groupId);
    }
    g_groupRecipients[groupId] = recipients;
    saveGroupRecipients();
    return rotate;
}

std::string groupSeal(const std::string &groupId, const std::string &contentJson,
                      std::uint64_t expectedEpoch) {
    // Реальный отправитель — ВНУТРЬ шифртекста (как в 1-на-1), путь inject единый.
    json inner;
    try {
        inner = {{"from", g_self}, {"content", json::parse(contentJson)}};
    } catch (const std::exception &) {
        return {};
    }
    std::lock_guard<std::mutex> lk(g_mu);
    if (!g_account || groupId.empty()) {
        return {};
    }
    auto *g = ensureOwnGroupLocked(groupId);
    const auto epoch = g_ownGroupEpoch.find(groupId);
    if (!g || epoch == g_ownGroupEpoch.end() || epoch->second != expectedEpoch) {
        return {};
    }
    const std::string ct = take(parvane_e2e_group_encrypt(g, b64e(inner.dump()).c_str()));
    if (ct.empty()) {
        return {};
    }
    persistOwnGroup(groupId, g); // ratchet-индекс продвинулся
    json enc = {
        {"kind", "group_encrypted"},
        {"ciphertext", ct},
        {"group", groupId},
        {"sender_identity", g_identityB64},
    };
    return enc.dump();
}

void groupAcceptKey(const std::string &groupId, const std::string &senderIdentity,
                    const std::string &sessionKeyB64, std::uint64_t epoch) {
    if (groupId.empty() || senderIdentity.empty() || sessionKeyB64.empty()) {
        return;
    }
    std::lock_guard<std::mutex> lk(g_mu);
    const std::string key = groupId + "|" + senderIdentity;
    // Принять, только если сессии ещё нет ЛИБО ключ новее (эпоха строго больше):
    //  • тот же ключ раз за разом (дедуп на каждой отправке) → эпоха равна → игнор
    //    (иначе сброс ratchet-индекса сломал бы уже расшифрованное);
    //  • ротация после удаления участника → эпоха больше → ЗАМЕНА входящей;
    //  • старый дубль SKDM из очереди → эпоха меньше → игнор (защита от отката).
    if (getInGroup(key)) {
        auto e = g_inGroupEpoch.find(key);
        const std::uint64_t have = (e == g_inGroupEpoch.end()) ? 0 : e->second;
        if (epoch <= have) {
            return;
        }
    }
    auto *ng = parvane_e2e_inbound_group_from_key(sessionKeyB64.c_str());
    if (!ng) {
        return;
    }
    auto old = g_inGroups.find(key);
    if (old != g_inGroups.end() && old->second) {
        parvane_e2e_inbound_group_free(old->second);
    }
    g_inGroups[key] = ng;
    g_inGroupEpoch[key] = epoch;
    persistInGroup(key, ng);
    saveEpochs();
}

std::string groupOpen(const std::string &groupId, const std::string &senderIdentity,
                      const std::string &ciphertext) {
    if (groupId.empty() || senderIdentity.empty() || ciphertext.empty()) {
        return {};
    }
    std::lock_guard<std::mutex> lk(g_mu);
    const std::string key = groupId + "|" + senderIdentity;
    auto *g = getInGroup(key);
    if (!g) {
        return {}; // SKDM ещё не пришёл
    }
    const std::string ptB64 = take(parvane_e2e_inbound_group_decrypt(g, ciphertext.c_str()));
    if (ptB64.empty()) {
        return {};
    }
    persistInGroup(key, g);
    return b64d(ptB64); // inner {from, content}
}

} // namespace parvane::e2e
