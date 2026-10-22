// Parvane Android (spec 031): окружение JNI — загрузка, очередь событий в Kotlin, хранилище, журнал истории
// (ORDER-1), сообщения в памяти, кэш групп и режима L2, кэш медиа, стирание данных при выходе (NAT-16).
#include "jni_internal.h"

#include <parvane/gateway_ws_transport.h>
#include <parvane/local_files.h>
#include <parvane/messenger.h>
#include <parvane/process_hardening.h>
#include <parvane/storecrypt.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <limits>
#include <thread>

namespace pvjni {

JavaVM *g_vm = nullptr;
std::mutex g_mu;
std::string g_gatewayUrl;
std::string g_storeDir;
std::string g_self;
std::string g_token;
std::string g_storeKey;
bool g_debugBuild = false;

namespace {

jclass g_coreClass = nullptr; // org.parvane.core.ParvaneCore
jmethodID g_onEvent = nullptr; // static void onEvent(String)

} // namespace

std::string jstr(JNIEnv *env, jstring s) { return parvane::jniutf::fromJava(env, s); }
jstring jout(JNIEnv *env, const std::string &s) { return parvane::jniutf::toJava(env, s); }
jstring jreply(JNIEnv *env, const json &j) { return jout(env, j.dump()); }
json jfail(const std::string &code, const std::string &text) {
    return json{{"ok", false}, {"error_code", code}, {"error", text}};
}

std::int64_t nowSec() {
    return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}
std::int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}
std::int64_t steadyMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
std::string self() {
    std::lock_guard<std::mutex> lk(g_mu);
    return g_self;
}
// Каталог хранилища — свой замок, не g_mu: его спрашивают и пути под g_mu (старт сессии, смена ника)
std::mutex g_dirMu;
std::string storeDir() {
    std::lock_guard<std::mutex> lk(g_dirMu);
    return g_storeDir;
}
std::string safePart(const std::string &address) { return parvane::accountfiles::safePart(address); }

std::string errorCodeOf(const std::exception &e) {
    if (const auto v2 = dynamic_cast<const parvane::v2::V2Error *>(&e)) return v2->code();
    return "failed";
}

// ── события в Kotlin ─────────────────────────────────────────────────────────

namespace {

void callOnEvent(const std::string &s) {
    if (!g_vm || !g_coreClass || !g_onEvent) return;
    JNIEnv *env = nullptr;
    bool attached = false;
    if (g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK) {
        if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
        attached = true;
    }
    jstring js = parvane::jniutf::toJava(env, s);
    env->CallStaticVoidMethod(g_coreClass, g_onEvent, js);
    env->DeleteLocalRef(js);
    if (env->ExceptionCheck()) { env->ExceptionDescribe(); env->ExceptionClear(); }
    if (attached) g_vm->DetachCurrentThread();
}

// Обработчики Kotlin зовут ядро прямо из onEvent; событие из потока чтения соединения дало бы взаимную
// блокировку (27 сен 2026) — поэтому очередь и отдельный поток, строго по порядку.
std::mutex g_emitMu;
std::condition_variable g_emitCv;
std::deque<std::string> g_emitQueue;
bool g_emitThreadStarted = false;

void emitLoop() {
    for (;;) {
        std::string s;
        {
            std::unique_lock<std::mutex> lk(g_emitMu);
            g_emitCv.wait(lk, [] { return !g_emitQueue.empty(); });
            s = std::move(g_emitQueue.front());
            g_emitQueue.pop_front();
        }
        callOnEvent(s);
    }
}

bool journaledType(const std::string &t) {
    return t == "message" || t == "edited" || t == "deleted" || t == "meta" || t == "outbox_read" || t == "read";
}

// TTL (spec 005): сообщение с ttl_secs не переживает перезапуск — не журналируем (как web/desktop).
bool hasTtl(const json &event) {
    const auto it = event.find("content");
    return it != event.end() && it->is_object() && it->value("ttl_secs", 0) > 0;
}

} // namespace

void emit(const json &event) {
    if (journaledType(event.value("type", "")) && !hasTtl(event)) journalAppend(event);
    if (!g_vm || !g_coreClass || !g_onEvent) return;
    {
        std::lock_guard<std::mutex> lk(g_emitMu);
        g_emitQueue.push_back(event.dump());
        if (!g_emitThreadStarted) {
            g_emitThreadStarted = true;
            std::thread(emitLoop).detach();
        }
    }
    g_emitCv.notify_one();
}

void emitNow(const json &event) { callOnEvent(event.dump()); }

// ── журнал истории ───────────────────────────────────────────────────────────

namespace {

std::mutex g_journalMu;
std::atomic<bool> g_replaying{false};
std::string journalPath() { return storeDir() + "/journal.jsonl"; }

// Строка, которая старше уже показанных больше чем на окно «живого» сообщения (ORDER-1, 300 с), встаёт на своё
// место по времени (перенесённая история могла лечь не по порядку); близкие по времени — порядком прихода.
// Сортировки здесь нет и быть не должно (как desktop ReplayHistory).
void placeByTime(std::vector<json> &msgs) {
    constexpr std::int64_t kLiveWindowSecs = 300;
    bool misplaced = false;
    auto latest = std::numeric_limits<std::int64_t>::min();
    for (const auto &m : msgs) {
        const auto ts = m.value("ts", std::int64_t(0));
        misplaced = misplaced || (ts + kLiveWindowSecs < latest);
        latest = std::max(latest, ts);
    }
    if (!misplaced) return;
    std::vector<json> ordered;
    ordered.reserve(msgs.size());
    for (auto &m : msgs) {
        const auto ts = m.value("ts", std::int64_t(0));
        auto at = ordered.size();
        while (at > 0 && ordered[at - 1].value("ts", std::int64_t(0)) > ts + kLiveWindowSecs) --at;
        ordered.insert(ordered.begin() + std::ptrdiff_t(at), std::move(m));
    }
    msgs = std::move(ordered);
}

} // namespace

void journalAppend(const json &event) {
    if (g_replaying) return;
    const auto path = journalPath();
    if (path.size() < 2) return;
    std::lock_guard<std::mutex> lk(g_journalMu);
    parvane::storecrypt::appendLine(path, event.dump());
}

std::vector<json> journalFold() {
    std::vector<std::string> order;
    std::map<std::string, json> msgs;
    std::lock_guard<std::mutex> lk(g_journalMu);
    for (const auto &line : parvane::storecrypt::readLines(journalPath())) {
        auto e = json::parse(line, nullptr, false);
        if (!e.is_object()) continue;
        const auto t = e.value("type", "");
        const auto id = e.value("id", "");
        if (t == "message") {
            if (id.empty()) continue;
            if (!msgs.count(id)) order.push_back(id);
            auto &m = msgs[id];
            // повтор (правка своего, своё эхо) — содержимое новое, мета прежняя
            if (m.is_object()) {
                e["reactions"] = m.value("reactions", json::array());
                e["by"] = m.value("by", json::object());
                e["pinned"] = m.value("pinned", false);
                if (m.value("read", false)) e["read"] = true;
            }
            m = e;
        } else if (t == "edited") {
            auto it = msgs.find(id);
            if (it != msgs.end()) { it->second["content"] = e["content"]; it->second["edited"] = true; }
        } else if (t == "deleted") {
            msgs.erase(id);
        } else if (t == "meta") {
            auto it = msgs.find(id);
            if (it != msgs.end()) {
                it->second["reactions"] = e.value("reactions", json::array());
                it->second["by"] = e.value("by", json::object());
                it->second["pinned"] = e.value("pinned", false);
            }
        } else if (t == "outbox_read") {
            auto it = msgs.find(id);
            if (it != msgs.end()) it->second["read"] = true;
        } else if (t == "read") {
            for (const auto &x : e.value("ids", json::array())) {
                if (!x.is_string()) continue;
                auto it = msgs.find(x.get<std::string>());
                if (it != msgs.end()) it->second["read"] = true;
            }
        }
    }
    std::vector<json> out;
    out.reserve(order.size());
    for (const auto &id : order) if (msgs.count(id)) out.push_back(std::move(msgs[id]));
    placeByTime(out);
    return out;
}

void journalRewrite(const std::vector<json> &messages) {
    std::vector<std::string> lines;
    lines.reserve(messages.size());
    for (const auto &m : messages) lines.push_back(m.dump());
    std::lock_guard<std::mutex> lk(g_journalMu);
    parvane::storecrypt::writeLines(journalPath(), lines);
}

void journalRemoveIds(const std::set<std::string> &ids) {
    if (ids.empty()) return;
    auto msgs = journalFold();
    msgs.erase(std::remove_if(msgs.begin(), msgs.end(), [&](const json &m) { return ids.count(m.value("id", "")) > 0; }),
               msgs.end());
    journalRewrite(msgs);
}

// Реплей в Kotlin по ПЕРВОМУ LoadChats/GetChats от X (не сразу после готовности: X на переходе в Ready сбрасывает
// состояние). Без g_mu: события идут в Kotlin синхронно, а его обработчики зовут ядро.
void journalReplay() {
    auto msgs = journalFold();
    if (msgs.empty()) return;
    g_replaying = true;
    for (const auto &m : msgs) {
        const auto id = m.value("id", "");
        (void)markSeen(id);
        const auto from = m.value("from", "");
        const auto to = m.value("to", "");
        const bool group = m.value("group", false);
        const auto chat = group ? to : (from == self() ? to : from);
        noteMessage(id, from, chat, m.value("content", json::object()));
        restoreMeta(id, m.value("by", json::object()), m.value("pinned", false));
        emitNow(m);
    }
    g_replaying = false;
    journalRewrite(msgs); // компакция
    LOGI("журнал: восстановлено %zu сообщений", msgs.size());
}

// ── сообщения в памяти ───────────────────────────────────────────────────────

namespace {
std::mutex g_msgMu;
std::map<std::string, MsgRow> g_msgs;
std::set<std::string> g_seen;
std::mutex g_capMu;
std::map<std::string, std::string> g_caps;
} // namespace

void noteMessage(const std::string &id, const std::string &from, const std::string &chat, const json &content) {
    if (id.empty()) return;
    rememberBlobCaps(content);
    std::lock_guard<std::mutex> lk(g_msgMu);
    g_msgs[id] = MsgRow{from, chat, content};
}

std::optional<MsgRow> messageRow(const std::string &id) {
    std::lock_guard<std::mutex> lk(g_msgMu);
    const auto it = g_msgs.find(id);
    if (it == g_msgs.end()) return std::nullopt;
    return it->second;
}

void updateMessageContent(const std::string &id, const json &content) {
    rememberBlobCaps(content);
    std::lock_guard<std::mutex> lk(g_msgMu);
    if (auto it = g_msgs.find(id); it != g_msgs.end()) it->second.content = content;
}

void forgetMessage(const std::string &id) {
    std::lock_guard<std::mutex> lk(g_msgMu);
    g_msgs.erase(id);
}

bool markSeen(const std::string &id) {
    std::lock_guard<std::mutex> lk(g_msgMu);
    return g_seen.insert(id).second;
}

void resetMessages() {
    {
        std::lock_guard<std::mutex> lk(g_msgMu);
        g_msgs.clear();
        g_seen.clear();
    }
    std::lock_guard<std::mutex> lk(g_capMu);
    g_caps.clear();
}

void rememberBlobCap(const std::string &fileId, const std::string &capB64) {
    if (fileId.empty() || capB64.empty()) return;
    std::lock_guard<std::mutex> lk(g_capMu);
    g_caps[fileId] = capB64;
}

void rememberBlobCaps(const json &content) {
    if (!content.is_object()) return;
    rememberBlobCap(content.value("file_id", std::string()), content.value("capability", std::string()));
    for (const auto *key : {"pack_ref", "thumb", "preview_photo"})
        if (content.contains(key) && content[key].is_object()) rememberBlobCaps(content[key]);
    for (const auto *key : {"emoji_packs", "media", "article_media"})
        if (content.contains(key) && content[key].is_array())
            for (const auto &ref : content[key]) rememberBlobCaps(ref);
    if (content.contains("webpage") && content["webpage"].is_object() && content["webpage"].contains("photo"))
        rememberBlobCaps(content["webpage"]["photo"]);
}

std::string blobCapOf(const std::string &fileId) {
    std::lock_guard<std::mutex> lk(g_capMu);
    const auto it = g_caps.find(fileId);
    return it == g_caps.end() ? std::string() : it->second;
}

// ── группы ───────────────────────────────────────────────────────────────────

namespace {
std::mutex g_groupMu;
std::map<std::string, std::vector<std::string>> g_groupMembers;
std::map<std::string, std::vector<json>> g_linkedGroupRows; // LINK-1 п. 8: строки ждут группу
std::string groupsCachePath() { return storeDir() + "/v2-groups.json"; }
} // namespace

bool isGroupAddress(const std::string &address) { return parvane::v2::isGroupAddress(address); }

void noteGroupMembers(const std::string &address, const std::vector<std::string> &members) {
    std::lock_guard<std::mutex> lk(g_groupMu);
    g_groupMembers[address] = members;
}

void forgetGroup(const std::string &address) {
    std::lock_guard<std::mutex> lk(g_groupMu);
    g_groupMembers.erase(address);
}

std::vector<std::string> groupMembers(const std::string &address) {
    std::lock_guard<std::mutex> lk(g_groupMu);
    const auto it = g_groupMembers.find(address);
    return it == g_groupMembers.end() ? std::vector<std::string>() : it->second;
}

bool groupKnown(const std::string &address) {
    std::lock_guard<std::mutex> lk(g_groupMu);
    return g_groupMembers.count(address) > 0;
}

void cacheGroupInfo(const std::string &address, const json *info) {
    std::lock_guard<std::mutex> lk(g_groupMu);
    auto all = json::parse(parvane::storecrypt::readFile(groupsCachePath()), nullptr, false);
    if (!all.is_object()) all = json::object();
    if (info) all[address] = *info; else all.erase(address);
    parvane::storecrypt::writeFile(groupsCachePath(), all.dump());
}

namespace {

bool isMember(const json &info, const std::string &me) {
    if (!info.is_object() || info.value("deleted", false)) return false;
    for (const auto &m : info.value("members", json::array()))
        if (m.value("user", std::string()) == me) return true;
    return false;
}

// Сведения журнала (groupInfo движка) → запись списка групп для шва (тот же вид, что прежде).
json groupJson(const std::string &address, const json &info) {
    const auto flag = [](const json &o, const char *k) { return o.is_object() && o.value(k, false); };
    auto members = json::array();
    for (const auto &m : info.value("members", json::array())) {
        const auto role = m.value("role", 1);
        json e{{"address", m.value("user", std::string())},
               {"role", role == 3 ? "owner" : role == 2 ? "admin" : "member"}};
        if (role == 2) {
            const auto r = m.value("rights", json::object());
            e["admin_rights"] = json{{"change_info", flag(r, "change_info")}, {"delete_messages", flag(r, "delete_messages")},
                                     {"ban_users", flag(r, "ban_users")}, {"invite_users", flag(r, "invite_users")},
                                     {"pin_messages", flag(r, "pin_messages")}, {"add_admins", flag(r, "add_admins")}};
        }
        members.push_back(std::move(e));
    }
    const auto p = info.value("defaultPermissions", json::object());
    json perms = json::object();
    for (const char *k : {"send_messages", "send_media", "send_stickers_gifs", "send_polls", "embed_links", "invite_users",
                          "pin_messages", "change_info"})
        perms[k] = flag(p, k);
    return json{{"group_id", address}, {"name", info.value("name", std::string())},
                {"kind", info.value("kind", 1) == 2 ? "channel" : "group"}, {"created_by", info.value("owner", std::string())},
                {"members", members}, {"avatar", info.value("avatarFileId", std::string())},
                {"about", info.value("about", std::string())}, {"default_permissions", perms},
                {"version", info.value("version", std::uint64_t(0))}, {"pending_requests", info.value("pendingRequests", -1)},
                {"public_name", info.value("publicName", std::string())}, {"is_public", info.value("isPublic", false)},
                {"proto", 2}};
}

} // namespace

// Список групп: из журнала готовой сессии, иначе — из кэша (реплей раньше подъёма сессии).
json groupListJson() {
    const auto me = self();
    json source = json::object();
    if (const auto s = v2Ready()) {
        for (const auto &address : s->groupAddresses()) {
            const auto info = s->groupInfo(address);
            if (isMember(info, me)) source[address] = info;
        }
        std::lock_guard<std::mutex> lk(g_groupMu);
        parvane::storecrypt::writeFile(groupsCachePath(), source.dump());
    } else {
        std::lock_guard<std::mutex> lk(g_groupMu);
        source = json::parse(parvane::storecrypt::readFile(groupsCachePath()), nullptr, false);
        if (!source.is_object()) source = json::object();
    }
    auto out = json::array();
    for (auto it = source.begin(); it != source.end(); ++it) {
        auto g = groupJson(it.key(), it.value());
        std::vector<std::string> mem;
        for (const auto &m : g["members"]) mem.push_back(m.value("address", std::string()));
        noteGroupMembers(it.key(), mem);
        out.push_back(std::move(g));
    }
    return out;
}

void deferLinkedGroupRow(const std::string &address, json event) {
    std::lock_guard<std::mutex> lk(g_groupMu);
    g_linkedGroupRows[address].push_back(std::move(event));
}

void flushLinkedGroupRows(const std::string &address) {
    std::vector<json> rows;
    {
        std::lock_guard<std::mutex> lk(g_groupMu);
        const auto it = g_linkedGroupRows.find(address);
        if (it == g_linkedGroupRows.end()) return;
        rows = std::move(it->second);
        g_linkedGroupRows.erase(it);
    }
    for (const auto &ev : rows) emit(ev);
}

void resetGroups() {
    std::lock_guard<std::mutex> lk(g_groupMu);
    g_groupMembers.clear();
    g_linkedGroupRows.clear();
}

// ── режим L2 ─────────────────────────────────────────────────────────────────

namespace {
std::mutex g_l2Mu;
std::set<std::string> g_l2Chats;
std::set<std::string> g_l2Mine;
std::atomic<bool> g_l2PresenceAllowed{true};
std::string l2CachePath() { return storeDir() + "/l2-chats.json"; }
} // namespace

bool l2Active(const std::string &chat) {
    std::lock_guard<std::mutex> lk(g_l2Mu);
    return g_l2Chats.count(chat) > 0;
}

bool presenceAllowed() { return g_l2PresenceAllowed.load(); }

void l2Store(const json &state, bool save) {
    {
        std::lock_guard<std::mutex> lk(g_l2Mu);
        g_l2Chats.clear();
        g_l2Mine.clear();
        for (const auto &c : state.value("chats", json::array())) if (c.is_string()) g_l2Chats.insert(c.get<std::string>());
        for (const auto &c : state.value("mine", json::array())) if (c.is_string()) g_l2Mine.insert(c.get<std::string>());
        g_l2PresenceAllowed = state.value("presence_allowed", true);
    }
    if (save) parvane::storecrypt::writeFile(l2CachePath(), state.dump());
}

void l2Load() {
    const auto raw = parvane::storecrypt::readFile(l2CachePath());
    const auto j = raw.empty() ? json() : json::parse(raw, nullptr, false);
    l2Store(j.is_object() ? j : json::object(), /*save=*/false);
}

void l2Forget() { l2Store(json::object(), /*save=*/false); }

// ── медиа ────────────────────────────────────────────────────────────────────

bool isSafeFileId(const std::string &fileId) {
    return !fileId.empty() && fileId.size() <= 64
        && std::all_of(fileId.begin(), fileId.end(), [](unsigned char ch) { return std::isalnum(ch) || ch == '-' || ch == '_'; });
}

std::string tempDir(const std::string &kind) { return parvane::localfiles::tempKindDir(storeDir(), kind); }

namespace {
std::string mediaCachePath(const std::string &fileId) {
    const auto dir = storeDir() + "/media-cache";
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    return dir + "/" + fileId;
}
} // namespace

std::optional<std::string> readMediaCache(const std::string &fileId) {
    if (!isSafeFileId(fileId)) return std::nullopt;
    const auto path = mediaCachePath(fileId);
    std::error_code ec;
    if (!std::filesystem::exists(path, ec)) return std::nullopt;
    auto blob = parvane::storecrypt::readFile(path);
    if (blob.empty()) return std::nullopt;
    return blob;
}

void writeMediaCache(const std::string &fileId, const std::string &bytes) {
    if (isSafeFileId(fileId) && !bytes.empty()) parvane::storecrypt::writeFile(mediaCachePath(fileId), bytes);
}

std::string mediaWorkCopy(const std::string &fileId, const std::string &bytes) {
    if (!isSafeFileId(fileId)) return {};
    const auto dir = tempDir("media");
    if (dir.empty()) return {};
    const auto path = dir + "/" + fileId;
    std::error_code ec;
    if (std::filesystem::exists(path, ec) && std::filesystem::file_size(path, ec) == bytes.size()) return path;
    std::ofstream o(path, std::ios::binary | std::ios::trunc);
    if (!o) return {};
    o.write(bytes.data(), std::streamsize(bytes.size()));
    o.close();
    std::filesystem::permissions(path, std::filesystem::perms::owner_read | std::filesystem::perms::owner_write,
                                 std::filesystem::perm_options::replace, ec);
    return o ? path : std::string();
}

BlobDownload downloadChatBlob(const std::string &fileId, std::size_t maxBytes) {
    BlobDownload d;
    if (const auto cap = blobCapOf(fileId); !cap.empty()) {
        if (const auto s = v2Ready()) {
            try {
                const auto secret = parvane::v2::fromBase64Safe(cap);
                if (!secret) throw std::runtime_error("секрет блоба не base64");
                d.bytes = s->downloadBlobCap(fileId, *secret, std::string(), maxBytes);
                d.ok = true;
            } catch (const std::exception &e) {
                d.error = e.what();
            }
            return d;
        }
    }
    const auto c = control();
    if (!c) {
        d.error = "нет соединения управления";
        return d;
    }
    try {
        d.bytes = c->downloadBlob(fileId, maxBytes);
        d.ok = true;
    } catch (const std::exception &e) {
        d.error = e.what();
    }
    return d;
}

// ── стирание данных аккаунта (NAT-16) ────────────────────────────────────────
// Каталог хранилища — только данные аккаунта и шва; остаётся ключ хранилища (обёрнут Keystore, принадлежит
// установке). Порядок как у desktop: маркер «выход не завершён» → ограда записи → стирание → маркер снят.

namespace {
std::mutex g_wipeMu;
} // namespace

void wipeAccountData(const char *why) {
    std::lock_guard<std::mutex> wl(g_wipeMu);
    const auto dir = storeDir();
    if (dir.size() < 2) return;
    parvane::storecrypt::blockWrites();
    int removed = 0, failed = 0;
    std::error_code ec;
    for (const auto &e : std::filesystem::directory_iterator(dir, ec)) {
        const auto name = e.path().filename().string();
        if (name == "store.key" || name == parvane::localfiles::kLogoutMarkerName) continue;
        std::error_code rec;
        std::filesystem::remove_all(e.path(), rec);
        if (rec) ++failed; else ++removed;
    }
    std::filesystem::remove(dir + "/" + parvane::localfiles::kLogoutMarkerName, ec);
    LOGI("%s — данные устройства стёрты (%d записей, не стёрто %d)", why, removed, failed);
}

bool prepareForLogin() {
    if (parvane::storecrypt::writesBlocked()) parvane::storecrypt::allowWrites();
    return true;
}

} // namespace pvjni

using namespace pvjni;

extern "C" {

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *) {
    // Системные CA Android для wss:// (статический OpenSSL их не знает); desktop этот путь закрывает
    setenv("PARVANE_CA_DIRS", "/apex/com.android.conscrypt/cacerts:/system/etc/security/cacerts", 1);
    parvane::GatewayWsTransport::setEnvCaDirsAllowed(true);
    (void)parvane::hardening::disableCoreDumps();
    g_vm = vm;
    JNIEnv *env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    jclass local = env->FindClass("org/parvane/core/ParvaneCore");
    if (!local) return JNI_ERR;
    g_coreClass = static_cast<jclass>(env->NewGlobalRef(local));
    g_onEvent = env->GetStaticMethodID(g_coreClass, "onEvent", "(Ljava/lang/String;)V");
    return g_onEvent ? JNI_VERSION_1_6 : JNI_ERR;
}

// storeKey — 32 байта ключа хранилища (P-13) из Android Keystore; debug — сборка с dev-хуками (без ключа
// хранилище пишет открыто только в debug — эмулятор без TEE; release без ключа не пишет ничего, NAT-13).
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeInit(
        JNIEnv *env, jclass, jstring gatewayUrl, jstring storeDirJ, jbyteArray storeKey, jboolean debug) {
    std::string key;
    if (storeKey && env->GetArrayLength(storeKey) == 32) {
        key.resize(32);
        env->GetByteArrayRegion(storeKey, 0, 32, reinterpret_cast<jbyte *>(key.data()));
    }
    const auto dir = jstr(env, storeDirJ);
    {
        std::lock_guard<std::mutex> lk(g_mu);
        g_gatewayUrl = jstr(env, gatewayUrl);
        g_storeKey = key;
        g_debugBuild = debug == JNI_TRUE;
    }
    {
        std::lock_guard<std::mutex> lk(g_dirMu);
        g_storeDir = dir;
    }
    parvane::logpriv::setDevBuild(g_debugBuild);
    parvane::storecrypt::setKey(key);
    parvane::storecrypt::setRequired(!g_debugBuild);
    if (!parvane::storecrypt::enabled())
        LOGE("хранилище: ключа нет — %s", g_debugBuild ? "debug-сборка пишет открыто" : "запись запрещена (NAT-13)");
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    // Выход, прерванный закрытием процесса, — дотереть до любого входа
    if (parvane::localfiles::logoutPending(dir)) {
        wipeAccountData("незавершённый выход дотёрт при старте");
        parvane::storecrypt::allowWrites();
    }
    // Каталог прежних версий (протокол v1: e2e-*, cursors.json, dec-cache.jsonl, …) — аккаунты прода стёрты
    // 10 окт 2026, состояние v1 не прочесть: начисто, один раз (spec 031)
    const auto layout = dir + "/layout-v2";
    if (!std::filesystem::exists(layout, ec)) {
        bool legacy = false;
        for (const auto *name : {"cursors.json", "dec-cache.jsonl", "pending.json", "v2-ids.txt"})
            legacy = legacy || std::filesystem::exists(dir + "/" + name, ec);
        for (const auto &e : std::filesystem::directory_iterator(dir, ec))
            legacy = legacy || e.path().filename().string().rfind("e2e-", 0) == 0;
        if (legacy) {
            wipeAccountData("каталог протокола v1");
            parvane::storecrypt::allowWrites();
        }
        parvane::storecrypt::writeRawFile(layout, "2");
    }
    // Расшифрованные копии прошлого запуска
    (void)parvane::localfiles::wipeTempRoot(dir);
    // Сессия с диска
    const auto raw = parvane::storecrypt::readFile(dir + "/session.json");
    const auto j = raw.empty() ? json() : json::parse(raw, nullptr, false);
    if (j.is_object() && parvane::accountfiles::isValidAddress(j.value("self", std::string()))) {
        std::lock_guard<std::mutex> lk(g_mu);
        g_self = j.value("self", std::string());
        g_token = j.value("token", std::string());
    }
    LOGI("init: store=%s self=%s encrypted=%d", dir.c_str(), self().empty() ? "-" : "set",
         parvane::storecrypt::enabled() ? 1 : 0);
}

// TdApi.Object/Function.toString() в бандле Telegram X объявлены native (жили в libtdjni) — имя класса.
static jstring classSimpleName(JNIEnv *env, jobject obj) {
    jclass cls = env->GetObjectClass(obj);
    jclass classClass = env->FindClass("java/lang/Class");
    jmethodID getSimpleName = env->GetMethodID(classClass, "getSimpleName", "()Ljava/lang/String;");
    auto name = static_cast<jstring>(env->CallObjectMethod(cls, getSimpleName));
    if (env->ExceptionCheck()) {
        env->ExceptionClear();
        return env->NewStringUTF("TdApi.Object");
    }
    return name;
}

JNIEXPORT jstring JNICALL Java_org_drinkless_tdlib_TdApi_00024Object_toString(JNIEnv *env, jobject obj) {
    return classSimpleName(env, obj);
}

JNIEXPORT jstring JNICALL Java_org_drinkless_tdlib_TdApi_00024Function_toString(JNIEnv *env, jobject obj) {
    return classSimpleName(env, obj);
}

// Файлы шва (черновики, отложенные, папки, …) — тем же storecrypt, что файлы ядра (P-13).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeStoreRead(JNIEnv *env, jclass, jstring pathJ) {
    return jout(env, parvane::storecrypt::readFile(jstr(env, pathJ)));
}

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeStoreWrite(JNIEnv *env, jclass, jstring pathJ, jstring textJ) {
    return parvane::storecrypt::writeFile(jstr(env, pathJ), jstr(env, textJ)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeReplayJournal(JNIEnv *, jclass) { journalReplay(); }

// Последние строки журнала клиента — для «Сообщить об ошибке» (без содержимого: logpriv).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeRecentLog(JNIEnv *env, jclass) {
    std::string out;
    for (const auto &line : parvane::logpriv::recent()) out += line + "\n";
    return jout(env, out);
}

} // extern "C"
