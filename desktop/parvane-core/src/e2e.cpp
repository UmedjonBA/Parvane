// Parvane fork: E2E-слой. См. e2e.h. Паритет с web e2e.ts/messages.ts.
// Sealed sender: реальный отправитель (from) едет ВНУТРИ шифртекста
// ({from,content}); сервер видит только шифртекст + identity/signing ключи
// отправителя. Сессии keyed по IDENTITY-ключу устройства собеседника; каталог
// устройств контакта (device_id → {identity, signing}) кэшируется 15 с.
#include "parvane/e2e.h"

#include "parvane_e2e.h" // C-FFI vodozemac (shared/parvane-e2e/include)
#include "parvane/itransport.h"
#include "parvane/linking.h"
#include "parvane/topics.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

using nlohmann::json;

namespace parvane::e2e {
namespace {

constexpr int kOneTimeBatch = 20;
constexpr int kOtkReplenishThreshold = 5;
constexpr std::uint64_t kDeviceListTtlMs = 15000;

struct DeviceInfo {
    std::string identity;
    std::string signing;
};

std::mutex g_mu;
ParvaneE2EAccount *g_account = nullptr;
std::map<std::string, ParvaneE2ESession *> g_sessions; // identity устройства → сессия
std::map<std::string, std::string> g_contactId;        // адрес → primary identity
std::map<std::string, std::map<std::string, DeviceInfo>> g_contactDevices; // адрес → dev → info
std::map<std::string, std::uint64_t> g_contactFetchedAt;                    // адрес → ms
std::map<std::string, ParvaneE2EGroupSession *> g_ownGroups;
std::map<std::string, ParvaneE2EInboundGroup *> g_inGroups;
std::map<std::string, std::uint64_t> g_ownGroupEpoch;
std::map<std::string, std::uint64_t> g_inGroupEpoch;
std::map<std::string, std::vector<std::string>> g_groupRecipients;
std::vector<ParvaneE2EAccount *> g_legacy; // legacy-подписанты (линковка)
std::string g_identityB64;
std::string g_signingB64;
std::string g_deviceId;
bool g_published = false;
std::int64_t g_otkNext = 1;
std::string g_self;
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

std::uint64_t nowMs() {
    return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
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
std::string devicePath() { return g_storeDir + "/device.json"; }
std::string sessionPath(const std::string &idB64) {
    return g_storeDir + "/sess_" + hexName(idB64) + ".json";
}
std::string contactsPath() { return g_storeDir + "/contacts.json"; }
std::string contactDevicesPath() { return g_storeDir + "/devices.json"; }
std::string groupRecipientsPath() { return g_storeDir + "/grecip.json"; }
std::string epochsPath() { return g_storeDir + "/gepoch.json"; }
std::string legacyPath(const std::string &signingB64) {
    return g_storeDir + "/legacy_" + hexName(signingB64) + ".json";
}
std::string ownGroupPath(const std::string &groupId) {
    return g_storeDir + "/gout_" + hexName(groupId) + ".json";
}
std::string inGroupPath(const std::string &key) {
    return g_storeDir + "/gin_" + hexName(key) + ".json";
}

void persistAccount() {
    if (g_storeDir.empty() || !g_account) {
        return;
    }
    writeFile(accountPath(), take(parvane_e2e_account_pickle(g_account)));
}
void persistDevice() {
    if (g_storeDir.empty()) {
        return;
    }
    json j = {{"device_id", g_deviceId}, {"published", g_published}, {"otk_next", g_otkNext}};
    writeFile(devicePath(), j.dump());
}
void loadDevice() {
    if (g_storeDir.empty()) {
        return;
    }
    auto j = json::parse(readFile(devicePath()), nullptr, false);
    if (!j.is_object()) {
        return;
    }
    g_deviceId = j.value("device_id", std::string());
    g_published = j.value("published", false);
    g_otkNext = j.value("otk_next", std::int64_t(1));
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
    auto j = json::parse(readFile(contactsPath()), nullptr, false);
    if (j.is_object()) {
        for (auto it = j.begin(); it != j.end(); ++it) {
            if (it.value().is_string()) {
                g_contactId[it.key()] = it.value().get<std::string>();
            }
        }
    }
}
void saveContactDevices() {
    if (g_storeDir.empty()) {
        return;
    }
    json j = json::object();
    for (const auto &[contact, devs] : g_contactDevices) {
        json d = json::object();
        for (const auto &[id, info] : devs) {
            d[id] = {{"identity", info.identity}, {"signing", info.signing}};
        }
        j[contact] = d;
    }
    writeFile(contactDevicesPath(), j.dump());
}
void loadContactDevices() {
    if (g_storeDir.empty()) {
        return;
    }
    auto j = json::parse(readFile(contactDevicesPath()), nullptr, false);
    if (!j.is_object()) {
        return;
    }
    for (auto it = j.begin(); it != j.end(); ++it) {
        if (!it.value().is_object()) {
            continue;
        }
        auto &devs = g_contactDevices[it.key()];
        for (auto d = it.value().begin(); d != it.value().end(); ++d) {
            if (d.value().is_object()) {
                devs[d.key()] = {d.value().value("identity", std::string()),
                                 d.value().value("signing", std::string())};
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
    const auto j = json::parse(readFile(groupRecipientsPath()), nullptr, false);
    if (!j.is_object()) {
        return;
    }
    for (auto it = j.begin(); it != j.end(); ++it) {
        if (it.value().is_array()) {
            g_groupRecipients[it.key()] = it.value().get<std::vector<std::string>>();
        }
    }
}
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
    auto j = json::parse(readFile(epochsPath()), nullptr, false);
    if (!j.is_object()) {
        return;
    }
    for (const char *sect : {"own", "in"}) {
        if (!j.contains(sect) || !j[sect].is_object()) {
            continue;
        }
        auto &dst = (std::string(sect) == "own") ? g_ownGroupEpoch : g_inGroupEpoch;
        for (auto it = j[sect].begin(); it != j[sect].end(); ++it) {
            if (it.value().is_number_unsigned()) {
                dst[it.key()] = it.value().get<std::uint64_t>();
            }
        }
    }
}
void loadLegacy() {
    if (g_storeDir.empty()) {
        return;
    }
    std::error_code ec;
    for (const auto &entry : std::filesystem::directory_iterator(g_storeDir, ec)) {
        const auto name = entry.path().filename().string();
        if (name.rfind("legacy_", 0) != 0) {
            continue;
        }
        const auto pickle = readFile(entry.path().string());
        if (pickle.empty()) {
            continue;
        }
        if (auto *acc = parvane_e2e_account_from_pickle(pickle.c_str())) {
            g_legacy.push_back(acc);
        }
    }
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

bool sessionExists(const std::string &idB64) {
    if (g_sessions.count(idB64)) {
        return true;
    }
    if (g_storeDir.empty() || idB64.empty()) {
        return false;
    }
    std::error_code ec;
    return std::filesystem::exists(sessionPath(idB64), ec);
}

// Все известные группы (память + диск): для ротации «всех своих».
std::set<std::string> allOwnGroupIdsLocked() {
    std::set<std::string> out;
    for (const auto &[g, _] : g_ownGroups) {
        out.insert(g);
    }
    for (const auto &[g, _] : g_ownGroupEpoch) {
        out.insert(g);
    }
    for (const auto &[g, _] : g_groupRecipients) {
        out.insert(g);
    }
    return out;
}

// ── публикация бандла ─────────────────────────────────────────────────────────
// Полный бандл (первая публикация) или пополнение one-time. Под g_mu → JSON
// запроса; сеть — вне лока.
json buildPublishPayloadLocked(const std::string &token) {
    const auto fallback = take(parvane_e2e_account_gen_fallback(g_account));
    const auto otksJson = take(parvane_e2e_account_gen_otks(g_account, kOneTimeBatch, g_otkNext));
    json otks = json::parse(otksJson, nullptr, false);
    if (!otks.is_array()) {
        otks = json::array();
    }
    g_otkNext += static_cast<std::int64_t>(otks.size());
    const auto sig = take(parvane_e2e_account_sign(g_account, fallback.c_str()));
    persistAccount();
    return json{
        {"token", token},
        {"device_id", g_deviceId},
        {"signing_key", g_signingB64},
        {"registration_id", 1},
        {"identity_key", g_identityB64},
        {"signed_prekey_id", 1},
        {"signed_prekey", fallback},
        {"signed_prekey_sig", sig},
        {"one_time", otks},
    };
}

// ── каталог устройств контакта (паритет refreshContactDevices) ───────────────
std::vector<std::string> knownDeviceIdsLocked(const std::string &contact) {
    std::vector<std::string> out;
    auto it = g_contactDevices.find(contact);
    if (it != g_contactDevices.end()) {
        for (const auto &[id, info] : it->second) {
            if (sessionExists(info.identity)) {
                out.push_back(id);
            }
        }
    }
    if (contact == g_self && !g_deviceId.empty()) {
        out.push_back(g_deviceId);
    }
    return out;
}

bool hasDeviceIdentityLocked(const std::string &contact, const std::string &identity) {
    auto it = g_contactDevices.find(contact);
    if (it != g_contactDevices.end()) {
        for (const auto &[id, info] : it->second) {
            if (info.identity == identity) {
                return true;
            }
        }
    }
    auto c = g_contactId.find(contact);
    return c != g_contactId.end() && c->second == identity;
}

void rotateGroupsWithLocked(const std::string &contact) {
    for (const auto &[group, recipients] : g_groupRecipients) {
        if (std::find(recipients.begin(), recipients.end(), contact) != recipients.end()) {
            rotateOwnGroupLocked(group);
        }
    }
}

// Перечитать каталог устройств контакта (identity.prekeys.fetch + known_devices).
// force — игнорировать TTL. Сеть вне лока.
void refreshContactDevices(const std::string &contact, ITransport &t, const std::string &token,
                           bool force) {
    std::vector<std::string> known;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_account) {
            return;
        }
        const auto fetched = g_contactFetchedAt.find(contact);
        const bool have = g_contactDevices.count(contact) && !g_contactDevices[contact].empty();
        if (!force && have && fetched != g_contactFetchedAt.end()
            && nowMs() - fetched->second < kDeviceListTtlMs) {
            return;
        }
        known = knownDeviceIdsLocked(contact);
    }
    json resp;
    try {
        json fr = {{"token", token}, {"user", contact}, {"known_devices", known}};
        resp = json::parse(t.request(topics::IdentityPrekeysFetch, fr.dump(), 5000));
    } catch (const std::exception &) {
        return;
    }
    if (!resp.is_object() || !resp.value("ok", false)) {
        return;
    }
    json devices = json::array();
    if (resp.contains("devices") && resp["devices"].is_array() && !resp["devices"].empty()) {
        devices = resp["devices"];
    } else if (resp.contains("identity_key") && resp["identity_key"].is_string()) {
        devices.push_back({{"device_id", ""},
                           {"signing_key", ""},
                           {"identity_key", resp["identity_key"]},
                           {"signed_prekey", resp.value("signed_prekey", "")},
                           {"one_time", resp.contains("one_time") ? resp["one_time"] : json()}});
    }
    if (devices.empty()) {
        return;
    }
    std::lock_guard<std::mutex> lk(g_mu);
    std::map<std::string, DeviceInfo> next;
    for (const auto &d : devices) {
        if (!d.is_object()) {
            continue;
        }
        const auto identity = d.value("identity_key", std::string());
        if (identity.empty() || identity == g_identityB64) {
            continue; // своё текущее устройство пропускаем
        }
        const auto devId = d.value("device_id", std::string());
        next[devId] = {identity, d.value("signing_key", std::string())};
        if (sessionExists(identity)) {
            continue;
        }
        std::string otk;
        if (d.contains("one_time") && d["one_time"].is_string()) {
            otk = d["one_time"].get<std::string>();
        }
        if (otk.empty() && d.contains("signed_prekey") && d["signed_prekey"].is_string()) {
            otk = d["signed_prekey"].get<std::string>();
        }
        if (otk.empty()) {
            continue;
        }
        if (auto *s = parvane_e2e_outbound(g_account, identity.c_str(), otk.c_str())) {
            g_sessions[identity] = s;
            persistSession(identity, s);
        }
    }
    bool lost = false;
    auto prev = g_contactDevices.find(contact);
    if (prev != g_contactDevices.end()) {
        for (const auto &[id, _] : prev->second) {
            if (!next.count(id)) {
                lost = true;
            }
        }
    }
    g_contactDevices[contact] = next;
    g_contactFetchedAt[contact] = nowMs();
    saveContactDevices();
    if (lost) {
        rotateGroupsWithLocked(contact);
    }
    // primary identity (legacy-кэш contact → identity) — устройство '' либо первое.
    std::string primary;
    for (const auto &d : devices) {
        if (d.is_object() && d.value("device_id", std::string("x")).empty()) {
            primary = d.value("identity_key", std::string());
            break;
        }
    }
    if (primary.empty()) {
        primary = devices[0].value("identity_key", std::string());
    }
    if (!primary.empty() && primary != g_identityB64 && g_contactId[contact] != primary) {
        g_contactId[contact] = primary;
        saveContacts();
    }
}

struct DeviceCopy {
    std::string deviceId;
    std::string signing;
    std::string ciphertext;
    std::uint32_t ctype = 0;
};

// Зашифровать inner для всех устройств контакта (кроме skipDeviceId). Вне лока
// сеть (refresh), под локом — шифрование.
std::vector<DeviceCopy> encryptForDevices(const std::string &contact, const std::string &innerJson,
                                          ITransport &t, const std::string &token,
                                          const std::optional<std::string> &skipDeviceId) {
    refreshContactDevices(contact, t, token, false);
    std::vector<DeviceCopy> out;
    std::lock_guard<std::mutex> lk(g_mu);
    auto it = g_contactDevices.find(contact);
    if (it == g_contactDevices.end()) {
        return out;
    }
    const auto ptB64 = b64e(innerJson);
    for (const auto &[devId, info] : it->second) {
        if (skipDeviceId && devId == *skipDeviceId) {
            continue;
        }
        auto *sess = getSession(info.identity);
        if (!sess) {
            continue;
        }
        std::uint32_t ctype = 0;
        const auto ct = take(parvane_e2e_encrypt(sess, ptB64.c_str(), &ctype));
        if (ct.empty()) {
            continue;
        }
        persistSession(info.identity, sess);
        out.push_back({devId, info.signing, ct, ctype});
    }
    return out;
}

} // namespace

json Copy::toJson() const {
    return json{{"recipient", recipient},
                {"signing_key", signing_key},
                {"device_id", device_id},
                {"ciphertext", ciphertext},
                {"ctype", ctype}};
}

void initDevice(ITransport &t, const std::string &self, const std::string &token,
                const std::string &storeDir) {
    json publish;
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
            std::filesystem::permissions(g_storeDir, std::filesystem::perms::owner_all,
                std::filesystem::perm_options::replace, ec);
            const auto pickle = readFile(accountPath());
            if (!pickle.empty()) {
                g_account = parvane_e2e_account_from_pickle(pickle.c_str());
            }
            loadDevice();
            loadContacts();
            loadContactDevices();
            loadEpochs();
            loadGroupRecipients();
            loadLegacy();
        }
        if (!g_account) {
            g_account = parvane_e2e_account_new();
            g_published = false;
            g_otkNext = 1;
            // Свежая установка → собственный device_id (не перетирает бандлы других
            // устройств аккаунта). Прежние установки без device.json остаются
            // legacy-устройством '' (wire back-compat).
            if (g_deviceId.empty() && readFile(devicePath()).empty()) {
                g_deviceId = linking::b64encode(linking::randomBytes(12));
                for (auto &c : g_deviceId) {
                    if (c == '+' || c == '/' || c == '=') {
                        c = 'x';
                    }
                }
            }
        }
        g_identityB64 = take(parvane_e2e_account_identity(g_account));
        g_signingB64 = take(parvane_e2e_account_ed25519(g_account));
        if (!g_published) {
            publish = buildPublishPayloadLocked(token);
        }
        persistDevice();
    }
    if (!publish.is_null()) {
        try {
            const auto resp = json::parse(t.request(topics::IdentityPrekeysPublish, publish.dump(), 5000));
            if (resp.value("ok", false)) {
                std::lock_guard<std::mutex> lk(g_mu);
                g_published = true;
                persistDevice();
            }
        } catch (const std::exception &) {
        }
        return;
    }
    // Уже публиковались: проверить остаток one-time (identity.device.list) и
    // долить пачку при < порога; устройства нет в каталоге (отозвано/сброс
    // сервера) — переопубликовать полный бандл.
    json resp;
    try {
        resp = json::parse(t.request(topics::IdentityDeviceList, json{{"token", token}}.dump(), 5000));
    } catch (const std::exception &) {
        return;
    }
    if (!resp.is_object() || !resp.value("ok", false) || !resp.contains("devices")) {
        return;
    }
    std::int64_t available = -1;
    for (const auto &d : resp["devices"]) {
        if (d.is_object() && d.value("device_id", std::string("x")) == g_deviceId) {
            available = d.value("one_time_available", std::int64_t(0));
        }
    }
    if (available >= kOtkReplenishThreshold) {
        return;
    }
    json topUp;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        topUp = buildPublishPayloadLocked(token);
        persistDevice();
    }
    try {
        t.request(topics::IdentityPrekeysPublish, topUp.dump(), 5000);
    } catch (const std::exception &) {
    }
}

bool ready() {
    std::lock_guard<std::mutex> lk(g_mu);
    return g_account != nullptr;
}

std::string myIdentity() {
    std::lock_guard<std::mutex> lk(g_mu);
    return g_identityB64;
}
std::string deviceId() {
    std::lock_guard<std::mutex> lk(g_mu);
    return g_deviceId;
}
std::string signingKey() {
    std::lock_guard<std::mutex> lk(g_mu);
    return g_signingB64;
}
std::string sign(const std::string &data) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (!g_account) {
        return {};
    }
    return take(parvane_e2e_account_sign(g_account, data.c_str()));
}
std::vector<std::pair<std::string, std::string>> extraSignatures(const std::string &data) {
    std::vector<std::pair<std::string, std::string>> out;
    std::lock_guard<std::mutex> lk(g_mu);
    for (auto *acc : g_legacy) {
        const auto key = take(parvane_e2e_account_ed25519(acc));
        const auto sig = take(parvane_e2e_account_sign(acc, data.c_str()));
        if (!key.empty() && !sig.empty()) {
            out.emplace_back(key, sig);
        }
        if (out.size() >= 8) {
            break;
        }
    }
    return out;
}

std::optional<Sealed> sealForAddress(const std::string &to, const std::string &contentJson,
                                     ITransport &t, const std::string &token) {
    json inner;
    std::string self, identity, signing, ownDevice;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_account) {
            return std::nullopt;
        }
        self = g_self;
        identity = g_identityB64;
        signing = g_signingB64;
        ownDevice = g_deviceId;
    }
    try {
        inner = {{"from", self}, {"content", json::parse(contentJson)}};
    } catch (const std::exception &) {
        return std::nullopt;
    }
    const auto innerStr = inner.dump();
    // Холодный старт (оба только вошли): получатель мог ещё не опубликовать
    // бандл — ~6 с ретраев, как раньше.
    std::vector<DeviceCopy> copies;
    // Для самого себя (SKDM своим устройствам) других устройств может не быть —
    // без ретраев, иначе каждая групповая отправка ждала бы ~6 с.
    const int attempts = (to == self) ? 1 : 12;
    for (int attempt = 0; attempt < attempts; ++attempt) {
        copies = encryptForDevices(to, innerStr, t, token, std::nullopt);
        if (!copies.empty()) {
            break;
        }
        refreshContactDevices(to, t, token, true);
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    if (copies.empty()) {
        return std::nullopt;
    }
    Sealed out;
    const DeviceCopy *primary = &copies[0];
    for (const auto &c : copies) {
        if (c.deviceId.empty()) {
            primary = &c;
        }
    }
    out.content = {
        {"kind", "encrypted"},
        {"ciphertext", primary->ciphertext},
        {"ctype", primary->ctype},
        {"sender_identity", identity},
        {"sender_signing_key", signing},
    };
    for (const auto &c : copies) {
        out.copies.push_back({to, std::string(), c.deviceId, c.ciphertext, c.ctype});
    }
    // Self-копии (свои другие устройства) — best-effort; признак — signing_key
    // ЦЕЛЕВОГО устройства (sealed sender: адрес не раскрываем).
    if (to != self) {
        const auto selfCopies = encryptForDevices(self, innerStr, t, token, ownDevice);
        for (const auto &c : selfCopies) {
            out.copies.push_back({std::string(), c.signing, c.deviceId, c.ciphertext, c.ctype});
        }
    }
    return out;
}

json pickOwnCopy(const json &content, const json &copies, const std::string &self) {
    if (!copies.is_array() || !content.is_object()) {
        return content;
    }
    std::string devId, signing;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        devId = g_deviceId;
        signing = g_signingB64;
    }
    for (const auto &c : copies) {
        if (!c.is_object() || c.value("device_id", std::string("x")) != devId) {
            continue;
        }
        const auto recipient = c.value("recipient", std::string());
        const auto sk = c.value("signing_key", std::string());
        if (recipient == self || (!sk.empty() && sk == signing)) {
            auto out = content;
            out["ciphertext"] = c.value("ciphertext", std::string());
            out["ctype"] = c.value("ctype", 0u);
            return out;
        }
    }
    return content;
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
        return b64d(take(outPt));
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

Verdict verifySender(const std::string &claimedFrom, const std::string &senderIdentity,
                     ITransport &t, const std::string &token) {
    if (claimedFrom.empty() || senderIdentity.empty()) {
        return Verdict::Unknown;
    }
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (senderIdentity == g_identityB64) {
            return claimedFrom == g_self ? Verdict::Ok : Verdict::Spoofed;
        }
        if (hasDeviceIdentityLocked(claimedFrom, senderIdentity)) {
            return Verdict::Ok;
        }
    }
    refreshContactDevices(claimedFrom, t, token, true);
    std::lock_guard<std::mutex> lk(g_mu);
    if (hasDeviceIdentityLocked(claimedFrom, senderIdentity)) {
        return Verdict::Ok;
    }
    return g_contactDevices.count(claimedFrom) ? Verdict::Spoofed : Verdict::Unknown;
}

void rememberContactIdentity(const std::string &contact, const std::string &identity) {
    if (contact.empty() || identity.empty()) {
        return;
    }
    std::lock_guard<std::mutex> lk(g_mu);
    if (contact == g_self) {
        return;
    }
    if (g_contactId[contact] != identity) {
        g_contactId[contact] = identity;
        saveContacts();
    }
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

// (под g_mu) Своя исходящая для группы + её эпоха; строго растущая эпоха.
namespace {
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
} // namespace

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
    ensureOwnGroupLocked(groupId);
    auto it = g_ownGroupEpoch.find(groupId);
    return it == g_ownGroupEpoch.end() ? 0 : it->second;
}

void groupRotate(const std::string &groupId) {
    if (groupId.empty()) {
        return;
    }
    std::lock_guard<std::mutex> lk(g_mu);
    rotateOwnGroupLocked(groupId);
}

bool groupSyncRecipients(const std::string &groupId, const std::vector<std::string> &members) {
    if (groupId.empty()) {
        return false;
    }
    auto recipients = members;
    std::lock_guard<std::mutex> lk(g_mu);
    recipients.erase(std::remove_if(recipients.begin(), recipients.end(), [](const auto &member) {
        return member.empty() || member == g_self;
    }), recipients.end());
    std::sort(recipients.begin(), recipients.end());
    recipients.erase(std::unique(recipients.begin(), recipients.end()), recipients.end());

    const auto previous = g_groupRecipients.find(groupId);
    bool rotate = false;
    if (previous == g_groupRecipients.end()) {
        rotate = getOwnGroup(groupId) != nullptr;
    } else {
        rotate = std::any_of(previous->second.begin(), previous->second.end(),
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

void primeContactDevices(const std::vector<std::string> &contacts, ITransport &t,
                         const std::string &token) {
    for (const auto &c : contacts) {
        if (!c.empty()) {
            refreshContactDevices(c, t, token, false);
        }
    }
}

std::string groupSeal(const std::string &groupId, const std::string &contentJson,
                      std::uint64_t expectedEpoch) {
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
    persistOwnGroup(groupId, g);
    json enc = {
        {"kind", "group_encrypted"},
        {"ciphertext", ct},
        {"group", groupId},
        {"sender_identity", g_identityB64},
        {"sender_signing_key", g_signingB64},
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
        return {};
    }
    const std::string ptB64 = take(parvane_e2e_inbound_group_decrypt(g, ciphertext.c_str()));
    if (ptB64.empty()) {
        return {};
    }
    persistInGroup(key, g);
    return b64d(ptB64);
}

void forgetOwnDevice(const std::string &deviceId) {
    std::lock_guard<std::mutex> lk(g_mu);
    auto it = g_contactDevices.find(g_self);
    if (it != g_contactDevices.end() && it->second.erase(deviceId)) {
        saveContactDevices();
    }
    g_contactFetchedAt.erase(g_self);
    for (const auto &group : allOwnGroupIdsLocked()) {
        rotateOwnGroupLocked(group);
    }
}

void rotateGroupsWith(const std::string &contact) {
    std::lock_guard<std::mutex> lk(g_mu);
    rotateGroupsWithLocked(contact);
}

bool needsHistoryLink(bool decCacheEmpty) {
    if (!decCacheEmpty) {
        return false;
    }
    std::lock_guard<std::mutex> lk(g_mu);
    if (!g_account || !g_sessions.empty() || !g_inGroups.empty() || !g_legacy.empty()) {
        return false;
    }
    if (g_storeDir.empty()) {
        return true;
    }
    std::error_code ec;
    for (const auto &entry : std::filesystem::directory_iterator(g_storeDir, ec)) {
        const auto name = entry.path().filename().string();
        if (name.rfind("sess_", 0) == 0 || name.rfind("gin_", 0) == 0) {
            return false;
        }
    }
    return true;
}

std::string exportStateJson(const json &decCache) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (!g_account) {
        return {};
    }
    const auto pickleKey = linking::b64encode(linking::randomBytes(32));
    json st;
    st["version"] = 2;
    st["pickleKey"] = pickleKey;
    st["account"] = take(parvane_e2e_account_to_libolm_pickle(g_account, pickleKey.c_str()));
    st["sessions"] = json::object();
    json contacts = json::object();
    for (const auto &[k, v] : g_contactId) {
        contacts[k] = v;
    }
    st["contacts"] = contacts;
    st["decCache"] = decCache.is_object() ? decCache : json::object();
    st["groupOut"] = json::object();
    // Входящие Megolm: все с диска + памяти, экспорт ключа с первого известного
    // индекса (формат libolm export_session — веб принимает через import_session).
    json groupIn = json::object();
    std::set<std::string> keys;
    for (const auto &[k, _] : g_inGroups) {
        keys.insert(k);
    }
    for (const auto &[k, _] : g_inGroupEpoch) {
        keys.insert(k);
    }
    for (const auto &key : keys) {
        auto *g = getInGroup(key);
        if (!g) {
            continue;
        }
        const auto e = g_inGroupEpoch.find(key);
        groupIn[key] = {{"exported", take(parvane_e2e_inbound_group_export(g))},
                        {"epoch", e == g_inGroupEpoch.end() ? 0 : e->second}};
    }
    st["groupIn"] = groupIn;
    json recipients = json::object();
    for (const auto &[g, r] : g_groupRecipients) {
        recipients[g] = r;
    }
    st["groupRecipients"] = recipients;
    st["published"] = g_published;
    st["deviceId"] = g_deviceId;
    json contactDevices = json::object();
    for (const auto &[contact, devs] : g_contactDevices) {
        json d = json::object();
        for (const auto &[id, info] : devs) {
            d[id] = {{"identity", info.identity}, {"signing", info.signing}};
        }
        contactDevices[contact] = d;
    }
    st["contactDevices"] = contactDevices;
    st["oneTimeKeyIdNext"] = g_otkNext;
    json legacy = json::array();
    for (auto *acc : g_legacy) {
        const auto p = take(parvane_e2e_account_to_libolm_pickle(acc, pickleKey.c_str()));
        if (!p.empty()) {
            legacy.push_back(p);
        }
    }
    st["legacyAccounts"] = legacy;
    return st.dump();
}

bool importLinkedHistory(
        const std::string &stateJson,
        const std::function<void(const std::string &uuid, const json &inner)> &onDecCache) {
    json st = json::parse(stateJson, nullptr, false);
    if (!st.is_object()) {
        return false;
    }
    const auto pickleKey = st.value("pickleKey", std::string());
    std::lock_guard<std::mutex> lk(g_mu);
    if (!g_account) {
        return false;
    }
    // decCache — решает вызывающий (только отсутствующие uuid).
    if (st.contains("decCache") && st["decCache"].is_object() && onDecCache) {
        for (auto it = st["decCache"].begin(); it != st["decCache"].end(); ++it) {
            onDecCache(it.key(), it.value());
        }
    }
    // Входящие Megolm: только отсутствующие ключи group|sender.
    if (st.contains("groupIn") && st["groupIn"].is_object()) {
        for (auto it = st["groupIn"].begin(); it != st["groupIn"].end(); ++it) {
            const auto &key = it.key();
            if (!it.value().is_object() || getInGroup(key)) {
                continue;
            }
            ParvaneE2EInboundGroup *g = nullptr;
            if (it.value().contains("exported") && it.value()["exported"].is_string()) {
                g = parvane_e2e_inbound_group_from_exported(
                    it.value()["exported"].get<std::string>().c_str());
            } else if (it.value().contains("pickle") && it.value()["pickle"].is_string()) {
                g = parvane_e2e_inbound_group_from_libolm_pickle(
                    it.value()["pickle"].get<std::string>().c_str(), pickleKey.c_str());
            }
            if (!g) {
                continue;
            }
            g_inGroups[key] = g;
            g_inGroupEpoch[key] = it.value().value("epoch", std::uint64_t(0));
            persistInGroup(key, g);
        }
        saveEpochs();
    }
    // Аккаунт(ы) прежних устройств → legacy-подписанты (только для extra_signing).
    std::vector<std::string> pickles;
    if (st.contains("account") && st["account"].is_string()) {
        pickles.push_back(st["account"].get<std::string>());
    }
    if (st.contains("legacyAccounts") && st["legacyAccounts"].is_array()) {
        for (const auto &p : st["legacyAccounts"]) {
            if (p.is_string()) {
                pickles.push_back(p.get<std::string>());
            }
        }
    }
    for (const auto &p : pickles) {
        auto *acc = parvane_e2e_account_from_libolm_pickle(p.c_str(), pickleKey.c_str());
        if (!acc) {
            continue;
        }
        const auto key = take(parvane_e2e_account_ed25519(acc));
        bool dup = key.empty() || key == g_signingB64;
        for (auto *have : g_legacy) {
            if (take(parvane_e2e_account_ed25519(have)) == key) {
                dup = true;
            }
        }
        if (dup) {
            parvane_e2e_account_free(acc);
            continue;
        }
        g_legacy.push_back(acc);
        if (!g_storeDir.empty()) {
            writeFile(legacyPath(key), take(parvane_e2e_account_pickle(acc)));
        }
    }
    // Контакты: дополняем отсутствующие primary identity.
    if (st.contains("contacts") && st["contacts"].is_object()) {
        for (auto it = st["contacts"].begin(); it != st["contacts"].end(); ++it) {
            if (it.value().is_string() && !g_contactId.count(it.key())) {
                g_contactId[it.key()] = it.value().get<std::string>();
            }
        }
        saveContacts();
    }
    return true;
}

} // namespace parvane::e2e
