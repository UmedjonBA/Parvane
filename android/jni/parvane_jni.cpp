// Parvane Android: JNI-фасад над parvane-core для shim'а org.drinkless.tdlib.Client.
// Одна сессия на процесс. Всё сетевое — на своих потоках; в Kotlin уходят
// события JSON через ParvaneCore.onEvent(String) (любой поток, Kotlin маршалит).
//
// Натив-API (org.parvane.core.ParvaneCore):
//   init(gatewayUrl, storeDir)            — конфигурация, восстановление сессии
//   serverDomain()                        — домен пузыря (identity.server.info)
//   login(user, password) → json          — identity.token.issue (+device_id)
//   startSession() → bool                 — транспорт, E2E, инбокс, pump sync
//   sendText(to, text) → uuid             — sealed 1-на-1 (fan-out по устройствам)
//   resolve(addressesJson) → usersJson    — identity.user.resolve
//   search(query) → usersJson             — identity.user.search
//   markRead(uuid)                        — msg.chat.read
//   self() / token()                      — текущая личность
//   logout()
// События: {"type":"message",id,from,to,ts,text,out,kind} | {"type":"delivered",id}
//          | {"type":"read",ids:[]} | {"type":"session",state} | {"type":"error",text}
#include <jni.h>
#include <cstdlib>
#include <android/log.h>

#include <parvane/e2e.h>
#include <parvane/events.h>
#include <parvane/blobcrypt.h>
#include <parvane/cloud_client.h>
#include <parvane/gateway_ws_transport.h>
#include <parvane/group_client.h>
#include <parvane/ids.h>
#include <parvane/keybackup.h>
#include <parvane/linking.h>
#include <parvane/messenger.h>
#include <parvane/messenger_client.h>
#include <parvane/topics.h>

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "parvane", __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "parvane", __VA_ARGS__)

using json = nlohmann::json;

namespace {

JavaVM *g_vm = nullptr;
jclass g_coreClass = nullptr;      // org.parvane.core.ParvaneCore (глобальная ссылка)
jmethodID g_onEvent = nullptr;     // static void onEvent(String)

std::mutex g_mu;
std::string g_gatewayUrl;
std::string g_storeDir;
std::string g_self;
std::string g_token;
std::unique_ptr<parvane::GatewayWsTransport> g_transport;
std::unique_ptr<parvane::MessengerClient> g_messenger;
std::thread g_pump;
std::atomic<bool> g_running{false};
std::set<std::string> g_seen;      // uuid уже отданных в Kotlin (дедуп sync/inbox)
std::string g_cursorId;            // курсоры инкрементального sync
std::int64_t g_cursorUpd = 0;
// Кэш расшифрованного (uuid → inner JSON): переживает рестарт и пере-синк
// (Olm-ратчет одноразовый) и принимает историю с другого устройства при
// линковке. Файл — dec-cache.jsonl в каталоге стора.
std::map<std::string, json> g_decCache;
// Линковка истории (новое устройство): оффер с эфемерным ключом, поллинг
// гранта в pump'е, импорт экспорта из cloud, пере-синк с нуля.
std::optional<parvane::linking::EphemeralKey> g_linkEph;
std::string g_linkCode;
std::int64_t g_linkStartedMs = 0;
bool g_linkActive = false;
constexpr std::int64_t kLinkOfferLifetimeMs = 10 * 60 * 1000;
std::int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch()).count();
}

std::string jstr(JNIEnv *env, jstring s) {
    if (!s) return {};
    const char *c = env->GetStringUTFChars(s, nullptr);
    std::string out = c ? c : "";
    env->ReleaseStringUTFChars(s, c);
    return out;
}

// ── Журнал истории (как parvane-history-*.jsonl на десктопе) ───────────────
// Kotlin-стор живёт в памяти, sync идёт от курсора: без журнала после рестарта
// список чатов пуст, пока не придёт новое сообщение (найдено 10 сен 2026).
// Пишем каждое событие message/edited/deleted/cleared/meta/outbox_read/read,
// при старте сворачиваем (последнее по uuid побеждает) и отдаём в Kotlin до sync.
std::string journalPath() { return g_storeDir + "/journal.jsonl"; }
std::mutex g_journalMu;
std::atomic<bool> g_replaying{false};
bool journaledType(const std::string &t) {
    return t == "message" || t == "edited" || t == "deleted" || t == "cleared" || t == "meta" || t == "outbox_read" || t == "read";
}
void journalAppend(const json &event) {
    if (g_replaying || g_storeDir.empty()) return;
    std::lock_guard<std::mutex> lk(g_journalMu);
    std::ofstream f(journalPath(), std::ios::app);
    f << event.dump() << '\n';
}
// Свёртка журнала → сообщения в порядке первого появления (с применёнными мутациями).
std::vector<json> journalFold() {
    std::vector<std::string> order;
    std::map<std::string, json> msgs;
    std::lock_guard<std::mutex> lk(g_journalMu);
    std::ifstream f(journalPath());
    std::string line;
    while (std::getline(f, line)) {
        auto e = json::parse(line, nullptr, false);
        if (!e.is_object()) continue;
        const auto t = e.value("type", "");
        const auto id = e.value("id", "");
        if (t == "message") {
            if (!msgs.count(id)) order.push_back(id);
            msgs[id] = e;
        } else if (t == "edited") {
            auto it = msgs.find(id);
            if (it != msgs.end()) { it->second["content"] = e["content"]; it->second["edited"] = true; }
        } else if (t == "deleted") {
            msgs.erase(id);
        } else if (t == "cleared") {
            for (const auto &x : e.value("ids", json::array())) if (x.is_string()) msgs.erase(x.get<std::string>());
        } else if (t == "meta") {
            auto it = msgs.find(id);
            if (it != msgs.end()) { it->second["reactions"] = e["reactions"]; it->second["pinned"] = e.value("pinned", false); }
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
    for (const auto &id : order) if (msgs.count(id)) out.push_back(msgs[id]);
    return out;
}

// Событие в Kotlin: аттачим поток к VM (pump/inbox — нативные потоки).
void emit(const json &event) {
    if (journaledType(event.value("type", ""))) journalAppend(event);
    if (!g_vm || !g_coreClass || !g_onEvent) return;
    JNIEnv *env = nullptr;
    bool attached = false;
    if (g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK) {
        if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
        attached = true;
    }
    const auto s = event.dump();
    jstring js = env->NewStringUTF(s.c_str());
    env->CallStaticVoidMethod(g_coreClass, g_onEvent, js);
    env->DeleteLocalRef(js);
    if (env->ExceptionCheck()) { env->ExceptionDescribe(); env->ExceptionClear(); } // видно в logcat как W/System.err
    if (attached) g_vm->DetachCurrentThread();
}

void emitError(const std::string &text) { emit(json{{"type", "error"}, {"text", text}}); }

// Реплей журнала в Kotlin: чаты и история видны сразу после рестарта. Журнал
// переписывается свёрнутым (компакция). Зовётся из Kotlin на ПЕРВЫЙ LoadChats
// от X, а не сразу после session ready: X на переходе в Ready сбрасывает
// состояние, и чаты, объявленные в ту же миллисекунду, терялись
// («updateChat not received» → падение debug-сборки). Без g_mu: события идут в
// Kotlin синхронно, а его обработчики зовут нативные функции под g_mu.
void journalReplay() {
    auto msgs = journalFold();
    if (msgs.empty()) return;
    g_replaying = true;
    for (const auto &m : msgs) {
        { std::lock_guard<std::mutex> lk(g_mu); g_seen.insert(m.value("id", "")); }
        emit(m);
    }
    g_replaying = false;
    {
        std::lock_guard<std::mutex> lk(g_journalMu);
        std::ofstream f(journalPath(), std::ios::trunc);
        for (const auto &m : msgs) f << m.dump() << '\n';
    }
    LOGI("журнал: восстановлено %zu сообщений", msgs.size());
}

std::string sessionPath() { return g_storeDir + "/session.json"; }
std::string cursorsPath() { return g_storeDir + "/cursors.json"; }
std::string e2eDir(const std::string &self) { return g_storeDir + "/e2e-" + self; }
std::string decCachePath() { return g_storeDir + "/dec-cache.jsonl"; }
std::string mediaDir() { return g_storeDir + "/media"; }
// Числовой id адреса как у десктопа/веба (FNV-1a 64 → 48 бит): subject'ы
// эфемерных тем msg.typing.<id> и presence.<id> должны совпадать у клиентов.
std::uint64_t idForAddress(const std::string &address) {
    std::uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : address) { h ^= c; h *= 1099511628211ULL; }
    h &= ((std::uint64_t(1) << 48) - 1);
    return h ? h : 1;
}
std::int64_t nowSec() {
    return std::chrono::duration_cast<std::chrono::seconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}
std::atomic<bool> g_presenceRunning{false};
// Группы: group_id → участники (без banned); typing-подписки по группам
std::map<std::string, std::vector<std::string>> g_groupMembers;
std::set<std::string> g_groupTypingSubscribed;
bool isGroupLocked(const std::string &address) { return g_groupMembers.count(address) > 0; }
void loadDecCache() {
    g_decCache.clear();
    std::size_t lines = 0;
    {
        std::ifstream f(decCachePath());
        std::string line;
        while (std::getline(f, line)) {
            ++lines;
            auto j = json::parse(line, nullptr, false);
            if (j.is_object() && j.contains("id") && j.contains("inner")) g_decCache[j["id"]] = j["inner"];
        }
    }
    // Компакция: файл append-only (импорт линковки, правки пишут те же id заново) —
    // без неё рос бесконечно; переписываем, когда дублей больше четверти.
    if (lines > g_decCache.size() + g_decCache.size() / 4 + 16) {
        std::ofstream f(decCachePath(), std::ios::trunc);
        for (const auto &[id, inner] : g_decCache) f << json{{"id", id}, {"inner", inner}}.dump() << "\n";
        LOGI("dec-cache: компакция %zu → %zu записей", lines, g_decCache.size());
    }
}
void decCachePut(const std::string &id, const json &inner) {
    if (g_decCache.count(id)) return;
    g_decCache[id] = inner;
    std::ofstream f(decCachePath(), std::ios::app);
    f << json{{"id", id}, {"inner", inner}}.dump() << "\n";
}

void saveSession() {
    std::ofstream f(sessionPath());
    f << json{{"self", g_self}, {"token", g_token}}.dump();
}
void loadSession() {
    std::ifstream f(sessionPath());
    if (!f) return;
    auto j = json::parse(f, nullptr, false);
    if (j.is_object()) {
        g_self = j.value("self", "");
        g_token = j.value("token", "");
    }
}
void saveCursors() {
    std::ofstream f(cursorsPath());
    f << json{{"id", g_cursorId}, {"upd", g_cursorUpd}}.dump();
}
void loadCursors() {
    std::ifstream f(cursorsPath());
    g_cursorId = parvane::MessengerClient::zeroCursor();
    if (!f) return;
    auto j = json::parse(f, nullptr, false);
    if (j.is_object()) {
        g_cursorId = j.value("id", std::string(parvane::MessengerClient::zeroCursor()));
        g_cursorUpd = j.value("upd", std::int64_t(0));
    }
}

// Одноразовый транспорт для bootstrap-запросов (issue/server.info) или с токеном.
std::unique_ptr<parvane::GatewayWsTransport> makeTransport(const std::string &token) {
    auto t = std::make_unique<parvane::GatewayWsTransport>();
    t->connectUrl(g_gatewayUrl);
    if (!token.empty()) t->authenticate(token);
    return t;
}

std::string serverDomain() {
    try {
        auto t = makeTransport("");
        const auto raw = t->request(std::string("identity.server.info"), "{}", 5000);
        const auto j = json::parse(raw, nullptr, false);
        if (j.is_object()) return j.value("domain", "");
    } catch (const std::exception &e) {
        LOGE("server.info: %s", e.what());
    }
    return {};
}

// Входящее/синк: расшифровать sealed-конверт, сверить отправителя, отдать событие.
// 1-на-1 sealed-отправка без событий/кэша (skdm-ключи групп). Под g_mu.
std::string sendSealed1to1Locked(const std::string &to, const json &content) {
    const auto sealed = parvane::e2e::sealForAddress(to, content.dump(), *g_transport, g_token);
    if (!sealed) return {};
    auto copies = json::array();
    for (const auto &c : sealed->copies) copies.push_back(c.toJson());
    const auto id = g_messenger->sendContent(std::string(), to, sealed->content, std::string(), std::nullopt, std::nullopt, copies);
    g_seen.insert(id);
    return id;
}
// Как sealGroup на десктопе: прогреть устройства, ротация при сокращении
// состава, skdm (ключ Megolm) каждому участнику и себе 1-на-1, затем
// group_encrypted-конверт. Под g_mu. Пусто — не удалось.
std::string sealGroupLocked(const std::string &gid, const json &content) {
    auto members = g_groupMembers[gid];
    {
        auto prime = members; prime.push_back(g_self);
        parvane::e2e::primeContactDevices(prime, *g_transport, g_token);
    }
    if (parvane::e2e::groupSyncRecipients(gid, members)) LOGI("группа %s: состав сократился — ротация ключа", gid.c_str());
    const auto skey = parvane::e2e::groupSessionKey(gid);
    const auto myId = parvane::e2e::myIdentity();
    if (skey.empty() || myId.empty()) return {};
    const auto epoch = parvane::e2e::groupEpoch(gid);
    const json skdm{{"kind", "skdm"}, {"group", gid}, {"session_key", skey}, {"sender_identity", myId}, {"epoch", epoch}};
    for (const auto &m : members) {
        if (m.empty() || m == g_self) continue;
        try { if (sendSealed1to1Locked(m, skdm).empty()) return {}; } catch (const std::exception &e) { LOGE("skdm → %s: %s", m.c_str(), e.what()); return {}; }
    }
    try { sendSealed1to1Locked(g_self, skdm); } catch (...) {}
    return parvane::e2e::groupSeal(gid, content.dump(), epoch);
}
// Список групп с сервера → g_groupMembers, ротации, typing-подписки. Под g_mu.
json refreshGroupsLocked() {
    auto out = json::array();
    if (!g_transport) return out;
    parvane::GroupClient gc(*g_transport);
    const auto groups = gc.list(g_token, 5000);
    for (const auto &gi : groups) {
        std::vector<std::string> mem;
        auto memJson = json::array();
        for (const auto &m : gi.members) {
            if (m.role == "banned") continue;
            mem.push_back(m.address);
            memJson.push_back(json{{"address", m.address}, {"role", m.role}});
        }
        g_groupMembers[gi.group_id] = mem;
        if (parvane::e2e::groupSyncRecipients(gi.group_id, mem)) LOGI("группа %s: участник выбыл — ротация ключа", gi.group_id.c_str());
        if (g_groupTypingSubscribed.insert(gi.group_id).second) {
            const auto gid = gi.group_id;
            g_transport->subscribe("msg.typing." + std::to_string(idForAddress(gid)), [gid](std::string, std::string payload) {
                auto j = json::parse(payload, nullptr, false);
                if (j.is_object() && j.value("from", "") != g_self)
                    emit(json{{"type", "typing"}, {"from", j.value("from", "")}, {"to", gid}});
            });
        }
        out.push_back(json{{"group_id", gi.group_id}, {"name", gi.name}, {"kind", gi.kind}, {"created_by", gi.created_by}, {"members", memJson}});
    }
    LOGI("групп синхронизировано: %zu", groups.size());
    return out;
}
json reactionsJson(const parvane::StoredMessage &sm) {
    auto arr = json::array();
    for (const auto &r : sm.reactions) arr.push_back(json{{"emoji", r.emoji}, {"count", r.count}, {"mine", r.mine}});
    return arr;
}
void deliverStored(parvane::StoredMessage sm, bool live) {
    if (sm.id.empty()) return;
    const bool seen = g_seen.count(sm.id) > 0;
    if (sm.deleted) { // tombstone: убрать из UI (и первый раз — не показывать)
        if (seen) emit(json{{"type", "deleted"}, {"id", sm.id}});
        g_seen.insert(sm.id);
        return;
    }
    std::string author = sm.from;
    if (seen && !sm.edited) { // уже показано: только мета, без повторной расшифровки
        const bool ownSeen = g_decCache.count(sm.id) && g_decCache[sm.id].value("from", "") == g_self;
        emit(json{{"type", "meta"}, {"id", sm.id}, {"reactions", reactionsJson(sm)}, {"pinned", sm.pinned}});
        if (ownSeen && sm.read) emit(json{{"type", "outbox_read"}, {"id", sm.id}});
        return;
    }
    if (parvane::contentKind(sm.content) == "encrypted") {
        const auto senderIdentity = sm.content.value("sender_identity", std::string());
        json inner;
        const auto cached = g_decCache.find(sm.id);
        // Правка приходит новым конвертом — кэш для неё устарел, открываем заново
        if (cached != g_decCache.end() && !(seen && sm.edited)) {
            inner = cached->second; // из кэша: свой прошлый декрипт или история по линковке
        } else {
            const auto dec = parvane::e2e::open(sm.from, sm.content.dump());
            if (dec.empty()) {
                LOGE("не расшифровано %s", sm.id.c_str());
                if (live && g_messenger) g_messenger->ack(g_self, sm.id, g_token, sm.from);
                return;
            }
            inner = json::parse(dec, nullptr, false);
            if (inner.is_object()) {
                if (seen && sm.edited) g_decCache[sm.id] = inner; else decCachePut(sm.id, inner);
            }
        }
        if (!inner.is_object()) return;
        const auto claimed = inner.value("from", std::string());
        if (!claimed.empty() && !senderIdentity.empty() && g_transport) {
            const auto v = parvane::e2e::verifySender(claimed, senderIdentity, *g_transport, g_token);
            if (v == parvane::e2e::Verdict::Spoofed) {
                LOGE("ОТКЛОНЕНО: подмена отправителя %s в %s", claimed.c_str(), sm.id.c_str());
                if (live && g_messenger) g_messenger->ack(g_self, sm.id, g_token, sm.from);
                return;
            }
            if (v == parvane::e2e::Verdict::Ok && claimed != g_self) {
                parvane::e2e::rememberContactIdentity(claimed, senderIdentity);
            }
        }
        if (!claimed.empty()) author = claimed;
        if (inner.contains("content")) sm.content = inner["content"];
        if (parvane::contentKind(sm.content) == "skdm") { // ключ группы от участника
            parvane::e2e::groupAcceptKey(sm.content.value("group", std::string()),
                sm.content.value("sender_identity", std::string()),
                sm.content.value("session_key", std::string()),
                sm.content.value("epoch", std::uint64_t(0)));
            g_seen.insert(sm.id);
            if (live && g_messenger) g_messenger->ack(g_self, sm.id, g_token, sm.from);
            return;
        }
    } else if (parvane::contentKind(sm.content) == "group_encrypted") {
        json inner;
        const auto cached = g_decCache.find(sm.id);
        if (cached != g_decCache.end() && !(seen && sm.edited)) {
            inner = cached->second;
        } else {
            const auto dec = parvane::e2e::groupOpen(sm.content.value("group", std::string()),
                sm.content.value("sender_identity", std::string()),
                sm.content.value("ciphertext", std::string()));
            if (dec.empty()) {
                LOGE("группа: не расшифровано %s (ждём ключ)", sm.id.c_str());
                return; // придёт skdm — sync повторит
            }
            inner = json::parse(dec, nullptr, false);
            if (inner.is_object()) {
                if (seen && sm.edited) g_decCache[sm.id] = inner; else decCachePut(sm.id, inner);
            }
        }
        if (!inner.is_object()) return;
        if (inner.contains("from") && inner["from"].is_string()) author = inner["from"].get<std::string>();
        if (inner.contains("content")) sm.content = inner["content"];
    }
    const bool out = (author == g_self);
    if (seen) { // мутации уже показанного: правка, реакции, закреп, ✓✓
        if (sm.edited) emit(json{{"type", "edited"}, {"id", sm.id}, {"content", sm.content}, {"edit_date", sm.updated_at}});
        emit(json{{"type", "meta"}, {"id", sm.id}, {"reactions", reactionsJson(sm)}, {"pinned", sm.pinned}});
        if (out && sm.read) emit(json{{"type", "outbox_read"}, {"id", sm.id}});
        return;
    }
    g_seen.insert(sm.id);
    const auto text = sm.text();
    LOGI("%s msg %s (%s): %s", out ? "своё" : "входящее", sm.id.c_str(), author.c_str(),
         text ? text->c_str() : "[медиа]");
    emit(json{{"type", "message"}, {"id", sm.id}, {"from", author}, {"to", sm.to},
              {"ts", sm.ts}, {"text", text ? *text : ""}, {"out", out},
              {"kind", parvane::contentKind(sm.content)}, {"read", sm.read},
              {"content", sm.content}, {"reply_to", sm.reply_to ? json(*sm.reply_to) : json()},
              {"edited", sm.edited}, {"pinned", sm.pinned}, {"reactions", reactionsJson(sm)},
              {"group", isGroupLocked(sm.to)}});
    if (live && !out && g_messenger) g_messenger->ack(g_self, sm.id, g_token, author);
}
// Sealed-отправка произвольного content (текст с ответом, медиа). Под g_mu.
std::string sendSealedLocked(const std::string &to, const json &content, const std::optional<std::string> &replyTo) {
    if (!g_messenger || !g_transport) throw std::runtime_error("нет сессии");
    if (!parvane::e2e::ready()) throw std::runtime_error("E2E не готов");
    if (isGroupLocked(to)) { // группа: Megolm-конверт, from/token настоящие
        const auto sealed = sealGroupLocked(to, content);
        if (sealed.empty()) throw std::runtime_error("E2E группы не удался");
        const auto id = g_messenger->sendContent(g_self, to, json::parse(sealed), g_token, replyTo);
        g_seen.insert(id);
        decCachePut(id, json{{"from", g_self}, {"content", content}});
        return id;
    }
    const auto sealed = parvane::e2e::sealForAddress(to, content.dump(), *g_transport, g_token);
    if (!sealed) {
        // «Избранное» на единственном устройстве: шифровать сообщение некому
        // (Olm требует устройство-получателя). Храним заметку локально — на
        // сервер не уходит, будущие устройства старых заметок не увидят (как и
        // у десктопа при одном устройстве). Для чужого адреса — честная ошибка.
        if (to != g_self) throw std::runtime_error("E2E: нет устройств получателя");
        const auto id = parvane::newUuidV7();
        g_seen.insert(id);
        decCachePut(id, json{{"from", g_self}, {"content", content}});
        emit(json{{"type", "message"}, {"id", id}, {"from", g_self}, {"to", to}, {"ts", nowSec()},
                  {"text", content.value("text", content.value("caption", std::string()))}, {"out", true},
                  {"kind", content.value("kind", "text")}, {"read", true}, {"content", content},
                  {"reply_to", replyTo ? json(*replyTo) : json()}});
        LOGI("заметка себе (локально) %s", id.c_str());
        return id;
    }
    auto copies = json::array();
    for (const auto &c : sealed->copies) copies.push_back(c.toJson());
    const auto id = g_messenger->sendContent(std::string(), to, sealed->content, std::string(), replyTo, std::nullopt, copies);
    g_seen.insert(id);
    decCachePut(id, json{{"from", g_self}, {"content", content}}); // своё: пережить рестарт/пере-синк
    return id;
}

// ── линковка истории (как StartHistoryLinkOffer/PollLinkGrantOnce на десктопе) ──
void startLinkOffer() {
    if (!g_transport) return;
    auto eph = parvane::linking::EphemeralKey::generate();
    if (!eph) return;
    const auto code = parvane::linking::sasCode(eph->publicB64());
    try {
        const auto raw = g_transport->request(parvane::topics::IdentityLinkOffer,
            json{{"token", g_token}, {"device_id", parvane::e2e::deviceId()},
                 {"eph_pub", eph->publicB64()}}.dump(), 5000);
        if (!json::parse(raw, nullptr, false).value("ok", false)) {
            LOGE("линковка: оффер отклонён");
            return;
        }
    } catch (const std::exception &e) {
        LOGE("линковка: оффер не опубликован: %s", e.what());
        return;
    }
    g_linkEph = std::move(eph);
    g_linkCode = code;
    g_linkStartedMs = nowMs();
    g_linkActive = true;
    LOGI("линковка: оффер опубликован, код %s — подтвердите на другом устройстве", code.c_str());
    emit(json{{"type", "link"}, {"state", "offered"}, {"code", code}});
}
void retractLinkOffer() {
    g_linkActive = false;
    g_linkEph.reset();
    if (!g_transport) return;
    try {
        g_transport->request(parvane::topics::IdentityLinkOffer,
            json{{"token", g_token}, {"device_id", parvane::e2e::deviceId()}, {"eph_pub", ""}}.dump(), 5000);
    } catch (const std::exception &) {}
}
// Под g_mu. true — линковка закончена (успех/отзыв), false — ждём дальше.
// Слияние состояния E2E (PersistedE2eState веба: линковка, копия ключей) в это
// устройство + пере-синк с нуля (старые сообщения придут снова и откроются из
// кэша). Под g_mu. Возвращает число новых записей кэша, −1 — ошибка.
int importStateLocked(const std::string &stateJson) {
    int merged = 0;
    const auto ok = parvane::e2e::importLinkedHistory(stateJson, [&](const std::string &uuid, const json &inner) {
        if (!inner.is_object() || g_decCache.count(uuid)) return;
        auto entry = inner;
        if (entry.contains("senderIdentity")) { entry["sender_identity"] = entry["senderIdentity"]; entry.erase("senderIdentity"); }
        decCachePut(uuid, entry);
        ++merged;
    });
    if (!ok) return -1;
    g_cursorId = parvane::MessengerClient::zeroCursor();
    g_cursorUpd = 0;
    g_seen.clear();
    saveCursors();
    return merged;
}
bool pollLinkGrantOnce() {
    if (!g_linkActive || !g_transport || !g_linkEph) return true;
    if (nowMs() - g_linkStartedMs > kLinkOfferLifetimeMs) {
        LOGI("линковка: оффер истёк (10 мин) — отзываю");
        retractLinkOffer();
        return true;
    }
    json grant;
    try {
        const auto raw = g_transport->request(parvane::topics::IdentityLinkPoll,
            json{{"token", g_token}, {"device_id", parvane::e2e::deviceId()}}.dump(), 5000);
        const auto resp = json::parse(raw, nullptr, false);
        if (!resp.is_object() || !resp.value("ok", false) || !resp.contains("grant") || !resp["grant"].is_object())
            return false;
        grant = resp["grant"];
    } catch (const std::exception &) {
        return false;
    }
    g_linkActive = false;
    const auto plain = g_linkEph->open(grant.value("eph_pub", std::string()), grant.value("box_payload", std::string()));
    g_linkEph.reset();
    if (!plain) { LOGE("линковка: бокс не расшифровался"); return true; }
    const auto box = json::parse(*plain, nullptr, false);
    if (!box.is_object()) return true;
    std::string stateJson;
    try {
        parvane::CloudClient cloud(*g_transport);
        auto d = cloud.download(g_self, g_token, box.value("file_id", std::string()), 30000);
        if (!d.ok) { LOGE("линковка: экспорт не скачался: %s", d.error.c_str()); return true; }
        const auto dec = parvane::blobcrypt::decrypt(d.bytes, box.value("file_key", std::string()),
                                                     box.value("file_nonce", std::string()));
        if (!dec) { LOGE("линковка: экспорт не расшифровался"); return true; }
        stateJson = *dec;
    } catch (const std::exception &e) {
        LOGE("линковка: скачивание: %s", e.what());
        return true;
    }
    const int merged = importStateLocked(stateJson);
    if (merged < 0) { LOGE("линковка: импорт не удался"); return true; }
    LOGI("линковка: история получена и импортирована (%d сообщений в кэше) — пере-синк с нуля", merged);
    emit(json{{"type", "link"}, {"state", "imported"}, {"count", merged}});
    return true;
}
void pumpLoop() {
    auto backoff = std::chrono::seconds(3);
    while (g_running) {
        try {
            parvane::MessengerClient::SyncAuth auth;
            auth.device_id = parvane::e2e::deviceId();
            auth.signing_key = parvane::e2e::signingKey();
            auth.signer = [](const std::string &d) { return parvane::e2e::sign(d); };
            auth.extra = [](const std::string &d) { return parvane::e2e::extraSignatures(d); };
            std::vector<std::string> readIds;
            std::vector<parvane::StoredMessage> page;
            std::string notifyBlob;
            {
                std::lock_guard<std::mutex> lk(g_mu);
                if (!g_messenger) break;
                if (g_linkActive) pollLinkGrantOnce();
                page = g_messenger->sync(g_self, g_token, g_cursorId, g_cursorUpd, 15000,
                                         parvane::e2e::ready() ? &auth : nullptr, &readIds, &notifyBlob);
            }
            if (!notifyBlob.empty()) {
                static std::string lastNotify;
                if (notifyBlob != lastNotify) { lastNotify = notifyBlob; emit(json{{"type", "notify"}, {"blob", notifyBlob}}); }
            }
            for (const auto &sm : page) {
                if (sm.id > g_cursorId) g_cursorId = sm.id;
                if (sm.updated_at > g_cursorUpd) g_cursorUpd = sm.updated_at;
                deliverStored(sm, /*live=*/false);
            }
            if (!page.empty()) saveCursors();
            if (!readIds.empty()) emit(json{{"type", "read"}, {"ids", readIds}});
            backoff = std::chrono::seconds(3);
        } catch (const std::exception &e) {
            LOGE("sync ошибка: %s", e.what());
            emitError(std::string("sync: ") + e.what());
            backoff = std::min(backoff * 2, std::chrono::seconds(30));
        }
        for (int i = 0; i < backoff.count() * 10 && g_running; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
}

} // namespace

extern "C" {

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *) {
    // Системные CA Android для wss:// (см. GatewayWsTransport::tlsConnect)
    setenv("PARVANE_CA_DIRS", "/apex/com.android.conscrypt/cacerts:/system/etc/security/cacerts", 0);
    g_vm = vm;
    JNIEnv *env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    jclass local = env->FindClass("org/parvane/core/ParvaneCore");
    if (!local) return JNI_ERR;
    g_coreClass = static_cast<jclass>(env->NewGlobalRef(local));
    g_onEvent = env->GetStaticMethodID(g_coreClass, "onEvent", "(Ljava/lang/String;)V");
    return g_onEvent ? JNI_VERSION_1_6 : JNI_ERR;
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeInit(
        JNIEnv *env, jclass, jstring gatewayUrl, jstring storeDir) {
    std::lock_guard<std::mutex> lk(g_mu);
    g_gatewayUrl = jstr(env, gatewayUrl);
    g_storeDir = jstr(env, storeDir);
    loadSession();
    LOGI("init: gateway=%s store=%s self=%s", g_gatewayUrl.c_str(), g_storeDir.c_str(), g_self.c_str());
}

// TdApi.Object/Function.toString() в бандле Telegram X объявлены native (жили
// в libtdjni, которого у нас нет): X зовёт их в логах («%s took %dms»), и без
// реализации — UnsatisfiedLinkError и краш (10 сен 2026). Возвращаем имя класса.
static jstring classSimpleName(JNIEnv *env, jobject self) {
    jclass cls = env->GetObjectClass(self);
    jclass classClass = env->FindClass("java/lang/Class");
    jmethodID getSimpleName = env->GetMethodID(classClass, "getSimpleName", "()Ljava/lang/String;");
    auto name = static_cast<jstring>(env->CallObjectMethod(cls, getSimpleName));
    if (env->ExceptionCheck()) {
        env->ExceptionClear();
        return env->NewStringUTF("TdApi.Object");
    }
    return name;
}

JNIEXPORT jstring JNICALL Java_org_drinkless_tdlib_TdApi_00024Object_toString(JNIEnv *env, jobject self) {
    return classSimpleName(env, self);
}

JNIEXPORT jstring JNICALL Java_org_drinkless_tdlib_TdApi_00024Function_toString(JNIEnv *env, jobject self) {
    return classSimpleName(env, self);
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeServerDomain(JNIEnv *env, jclass) {
    return env->NewStringUTF(serverDomain().c_str());
}

// Секрет доверия 2FA (как tdata/parvane-trust-<адрес>.txt на десктопе): устройство,
// однажды подтверждённое в Telegram, при следующих входах не спрашивает подтверждения.
std::string trustPath(const std::string &address) { return g_storeDir + "/trust-" + address + ".txt"; }
std::string readTrust(const std::string &address) {
    std::ifstream f(trustPath(address)); std::string s; std::getline(f, s); return s;
}
void writeTrust(const std::string &address, const std::string &secret) {
    std::ofstream f(trustPath(address), std::ios::trunc); f << secret;
}
std::string canonicalAddress(std::string address) {
    if (address.find('@') == std::string::npos) {
        const auto domain = serverDomain();
        if (domain.empty()) throw std::runtime_error("сервер недоступен");
        address += "@" + domain;
    }
    return address;
}
// identity.token.issue. Ответ: {ok, address | error, twofa_required, login_token}.
// loginToken — подтверждённый в Telegram токен второго фактора (пусто — обычный вход).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeLogin(
        JNIEnv *env, jclass, jstring user, jstring password, jstring loginToken) {
    json out{{"ok", false}};
    try {
        const auto address = canonicalAddress(jstr(env, user));
        parvane::IssueRequest req{address, jstr(env, password)};
        req.deviceId = parvane::e2e::ensureDeviceId(e2eDir(address));
        auto reqJson = req.toJson();
        if (const auto lt = jstr(env, loginToken); !lt.empty()) reqJson["login_token"] = lt;
        if (const auto secret = readTrust(address); !secret.empty()) reqJson["trust_secret"] = secret;
        auto t = makeTransport("");
        const auto raw = t->request(parvane::topics::IdentityIssue, reqJson.dump(), 8000);
        const auto rawJson = json::parse(raw, nullptr, false);
        const auto resp = parvane::IssueResponse::fromJson(rawJson);
        if (rawJson.is_object() && rawJson.contains("trust_secret") && rawJson["trust_secret"].is_string())
            writeTrust(address, rawJson["trust_secret"].get<std::string>());
        if (!resp.ok || !resp.token) {
            out["error"] = resp.error.value_or("неверный логин или пароль");
            if (rawJson.is_object() && rawJson.value("twofa_required", false)) {
                out["twofa_required"] = true;
                out["login_token"] = rawJson.value("login_token", "");
                out["address"] = address;
            }
        } else {
            std::lock_guard<std::mutex> lk(g_mu);
            g_self = address;
            g_token = *resp.token;
            saveSession();
            out["ok"] = true;
            out["address"] = address;
        }
    } catch (const std::exception &e) {
        out["error"] = e.what();
    }
    return env->NewStringUTF(out.dump().c_str());
}
// identity.server.info → {domain, confirm ("telegram"|"email"|""), telegram_bot}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeServerInfo(JNIEnv *env, jclass) {
    json out{{"domain", ""}, {"confirm", ""}, {"telegram_bot", ""}};
    try {
        auto t = makeTransport("");
        const auto j = json::parse(t->request(std::string("identity.server.info"), "{}", 5000), nullptr, false);
        if (j.is_object()) {
            out["domain"] = j.value("domain", "");
            out["telegram_bot"] = j.value("telegram_bot", "");
            if (j.contains("confirm") && j["confirm"].is_string()) out["confirm"] = j["confirm"];
            else if (j.value("email_required", false)) out["confirm"] = "email";
        }
    } catch (const std::exception &e) { out["error"] = e.what(); }
    return env->NewStringUTF(out.dump().c_str());
}
// identity.user.register (как Parvane::Register десктопа) → {ok, address, confirm_required, telegram_token, error}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeRegister(
        JNIEnv *env, jclass, jstring user, jstring password, jstring email) {
    json out{{"ok", false}};
    try {
        const auto address = canonicalAddress(jstr(env, user));
        out["address"] = address;
        auto t = makeTransport("");
        const json req{{"user", address}, {"password", jstr(env, password)}, {"invite", ""}, {"email", jstr(env, email)}};
        const auto resp = json::parse(t->request(parvane::topics::IdentityRegister, req.dump(), 8000), nullptr, false);
        if (!resp.is_object()) throw std::runtime_error("битый ответ identity");
        out["ok"] = resp.value("ok", false);
        out["confirm_required"] = resp.value("confirm_required", false);
        if (resp.contains("telegram_token") && resp["telegram_token"].is_string()) out["telegram_token"] = resp["telegram_token"];
        if (resp.contains("error") && resp["error"].is_string()) out["error"] = resp["error"];
        if (!out["ok"].get<bool>() && !out.contains("error")) out["error"] = "identity отклонил регистрацию";
    } catch (const std::exception &e) { out["error"] = e.what(); }
    return env->NewStringUTF(out.dump().c_str());
}
// identity.register.status — подтверждён ли токен (регистрация или 2FA-вход) в Telegram-боте
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeRegisterStatus(JNIEnv *env, jclass, jstring user, jstring token) {
    try {
        auto t = makeTransport("");
        const json req{{"user", jstr(env, user)}, {"token", jstr(env, token)}};
        return json::parse(t->request(std::string("identity.register.status"), req.dump(), 5000), nullptr, false).value("confirmed", false) ? JNI_TRUE : JNI_FALSE;
    } catch (const std::exception &e) { LOGE("register.status: %s", e.what()); return JNI_FALSE; }
}
// identity.email.confirm — код из письма → {ok, error}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeConfirmEmail(JNIEnv *env, jclass, jstring user, jstring code) {
    json out{{"ok", false}};
    try {
        auto t = makeTransport("");
        const json req{{"user", jstr(env, user)}, {"code", jstr(env, code)}};
        const auto resp = json::parse(t->request(parvane::topics::IdentityEmailConfirm, req.dump(), 5000), nullptr, false);
        out["ok"] = resp.value("ok", false);
        if (resp.contains("error") && resp["error"].is_string()) out["error"] = resp["error"];
        if (!out["ok"].get<bool>() && !out.contains("error")) out["error"] = "неверный код";
    } catch (const std::exception &e) { out["error"] = e.what(); }
    return env->NewStringUTF(out.dump().c_str());
}
// ── устройства (identity.device.list / revoke), как Settings → Devices десктопа ──
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeListDevices(JNIEnv *env, jclass) {
    auto out = json::array();
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_transport) throw std::runtime_error("нет сессии");
        const auto resp = json::parse(g_transport->request(parvane::topics::IdentityDeviceList, json{{"token", g_token}}.dump(), 5000), nullptr, false);
        const auto mine = parvane::e2e::deviceId();
        if (resp.is_object() && resp.value("ok", false) && resp.contains("devices") && resp["devices"].is_array()) {
            for (const auto &d : resp["devices"]) {
                if (!d.is_object()) continue;
                const auto id = d.value("device_id", std::string());
                out.push_back(json{{"device_id", id}, {"updated_at", d.value("updated_at", std::int64_t(0))},
                                   {"one_time_available", d.value("one_time_available", 0)}, {"current", id == mine}});
            }
        }
    } catch (const std::exception &e) { LOGE("device.list: %s", e.what()); }
    return env->NewStringUTF(out.dump().c_str());
}
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeRevokeDevice(JNIEnv *env, jclass, jstring deviceId) {
    const auto dev = jstr(env, deviceId);
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_transport) throw std::runtime_error("нет сессии");
        if (dev == parvane::e2e::deviceId()) return JNI_FALSE; // себя не отзываем
        const auto resp = json::parse(g_transport->request(parvane::topics::IdentityDeviceRevoke, json{{"token", g_token}, {"device_id", dev}}.dump(), 5000), nullptr, false);
        return resp.value("ok", false) ? JNI_TRUE : JNI_FALSE;
    } catch (const std::exception &e) { LOGE("device.revoke: %s", e.what()); return JNI_FALSE; }
}
// ── копия ключей под паролем (формат веб-клиента, parvane-core keybackup) ──
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeExportKeys(JNIEnv *env, jclass, jstring password) {
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!parvane::e2e::ready()) throw std::runtime_error("ключи ещё не готовы — подождите после входа");
        auto snap = json::object();
        for (const auto &[id, inner] : g_decCache) snap[id] = inner;
        const auto state = parvane::e2e::exportStateJson(snap);
        if (state.empty()) throw std::runtime_error("нечего сохранять");
        const auto file = parvane::keybackup::exportEncrypted(state, jstr(env, password));
        if (file.empty()) throw std::runtime_error("не удалось зашифровать копию");
        LOGI("копия ключей: %zu байт", file.size());
        return env->NewStringUTF(file.c_str());
    } catch (const std::exception &e) { LOGE("exportKeys: %s", e.what()); return env->NewStringUTF(""); }
}
// → число новых записей в кэше; −1 — неверный пароль/битый файл; −2 — E2E не готов
JNIEXPORT jint JNICALL Java_org_parvane_core_ParvaneCore_nativeImportKeys(JNIEnv *env, jclass, jstring fileJson, jstring password) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (!parvane::e2e::ready()) return -2;
    const auto state = parvane::keybackup::importEncrypted(jstr(env, fileJson), jstr(env, password));
    if (!state) return -1;
    const int merged = importStateLocked(*state);
    if (merged >= 0) { LOGI("копия ключей восстановлена: %d записей — пере-синк", merged); emit(json{{"type", "link"}, {"state", "imported"}, {"count", merged}}); }
    return merged;
}

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeStartSession(JNIEnv *, jclass) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (g_messenger) return JNI_TRUE;
    if (g_self.empty() || g_token.empty()) return JNI_FALSE;
    try {
        g_transport = makeTransport(g_token);
        g_messenger = std::make_unique<parvane::MessengerClient>(*g_transport);
        parvane::e2e::initDevice(*g_transport, g_self, g_token, e2eDir(g_self));
        loadCursors();
        loadDecCache();
        // Новое устройство без истории → просим ключи/историю у других устройств
        if (parvane::e2e::needsHistoryLink(g_decCache.empty()) && !getenv("PARVANE_NO_LINK_OFFER")) {
            startLinkOffer();
        }
        g_messenger->onInbox(g_self, [](parvane::StoredMessage sm) { deliverStored(std::move(sm), true); });
        g_messenger->onDelivered(g_self, [](std::string id) {
            emit(json{{"type", "delivered"}, {"id", id}});
        });
        g_messenger->onReadNotice(g_self, [](std::vector<std::string> ids) {
            emit(json{{"type", "read"}, {"ids", ids}});
        });
        g_messenger->onCleared(g_self, [](std::vector<std::string> ids) {
            emit(json{{"type", "cleared"}, {"ids", ids}});
        });
        // Настройки уведомлений с другого устройства (NotifyNotice в инбоксе)
        g_messenger->onNotifyNotice(g_self, [](std::string blob) {
            emit(json{{"type", "notify"}, {"blob", blob}});
        });
        // «печатает…» и присутствие — эфемерные темы, как на десктопе/вебе
        g_transport->subscribe("msg.typing." + std::to_string(idForAddress(g_self)),
            [](std::string, std::string payload) {
                auto j = json::parse(payload, nullptr, false);
                if (j.is_object() && j.value("from", "") != g_self) {
                    LOGI("печатает: %s", j.value("from", "").c_str());
                    emit(json{{"type", "typing"}, {"from", j.value("from", "")}, {"to", j.value("to", "")}});
                }
            });
        g_transport->subscribe("presence.*", [](std::string, std::string payload) {
            auto j = json::parse(payload, nullptr, false);
            if (j.is_object() && j.value("from", "") != g_self) {
                static std::set<std::string> logged;
                if (logged.insert(j.value("from", "")).second) LOGI("присутствие: %s онлайн", j.value("from", "").c_str());
                emit(json{{"type", "presence"}, {"from", j.value("from", "")}});
            }
        });
        if (!g_presenceRunning.exchange(true)) {
            std::thread([] {
                while (g_presenceRunning) {
                    {
                        std::lock_guard<std::mutex> lk(g_mu);
                        if (g_transport && !g_self.empty()) {
                            try { g_transport->publish("presence." + std::to_string(idForAddress(g_self)), json{{"from", g_self}}.dump()); } catch (...) {}
                        }
                    }
                    for (int i = 0; i < 300 && g_presenceRunning; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
                }
            }).detach();
        }
        g_running = true;
        g_pump = std::thread(pumpLoop);
        g_pump.detach();
        emit(json{{"type", "session"}, {"state", "ready"}, {"self", g_self}});
        LOGI("сессия поднята для %s", g_self.c_str());
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("startSession: %s", e.what());
        g_messenger.reset();
        g_transport.reset();
        emit(json{{"type", "session"}, {"state", "failed"}, {"error", e.what()}});
        return JNI_FALSE;
    }
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSendText(
        JNIEnv *env, jclass, jstring to, jstring text) {
    const auto toStd = jstr(env, to);
    const auto body = jstr(env, text);
    std::string id;
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_messenger || !g_transport) throw std::runtime_error("нет сессии");
        if (!parvane::e2e::ready()) throw std::runtime_error("E2E не готов");
        const auto content = parvane::textContent(body);
        const auto sealed = parvane::e2e::sealForAddress(toStd, content.dump(), *g_transport, g_token);
        if (!sealed) throw std::runtime_error("E2E: нет устройств получателя");
        auto copies = json::array();
        for (const auto &c : sealed->copies) copies.push_back(c.toJson());
        // sealed sender: from/token на проводе пустые (gateway уже аутентифицировал)
        id = g_messenger->sendContent(std::string(), toStd, sealed->content, std::string(),
                                      std::nullopt, std::nullopt, copies);
        g_seen.insert(id);
    } catch (const std::exception &e) {
        LOGE("sendText: %s", e.what());
        emitError(std::string("send: ") + e.what());
        return env->NewStringUTF("");
    }
    LOGI("отправлено msg %s → %s", id.c_str(), toStd.c_str());
    emit(json{{"type", "message"}, {"id", id}, {"from", g_self}, {"to", toStd},
              {"ts", std::chrono::duration_cast<std::chrono::seconds>(
                         std::chrono::system_clock::now().time_since_epoch()).count()},
              {"text", body}, {"out", true}, {"kind", "text"}, {"read", false}});
    return env->NewStringUTF(id.c_str());
}

// Текст с ответом (reply_to) — тот же sealed-путь.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSendContent(
        JNIEnv *env, jclass, jstring to, jstring contentJson, jstring replyTo) {
    const auto toStd = jstr(env, to);
    const auto reply = jstr(env, replyTo);
    std::string id;
    try {
        auto content = json::parse(jstr(env, contentJson), nullptr, false);
        if (!content.is_object()) throw std::runtime_error("битый content");
        std::lock_guard<std::mutex> lk(g_mu);
        id = sendSealedLocked(toStd, content, reply.empty() ? std::nullopt : std::optional<std::string>(reply));
    } catch (const std::exception &e) {
        LOGE("sendContent: %s", e.what());
        return env->NewStringUTF("");
    }
    LOGI("отправлено msg %s → %s", id.c_str(), toStd.c_str());
    journalAppend(json{{"type", "message"}, {"id", id}, {"from", g_self}, {"to", toStd}, {"ts", nowSec()},
                       {"out", true}, {"read", false}, {"content", json::parse(jstr(env, contentJson), nullptr, false)},
                       {"reply_to", reply.empty() ? json() : json(reply)}, {"group", isGroupLocked(toStd)}});
    return env->NewStringUTF(id.c_str());
}
// Медиа: байты → blobcrypt → cloud → sealed-сообщение с file_id/file_key/file_nonce;
// локальная копия под file_id и событие message (out) в Kotlin. Пусто — ошибка (в логе).
// content — {kind, mime, width, height, duration_secs, filename, caption[, forwarded_name]}.
std::string sendMediaBytes(const std::string &toStd, const std::string &plain, json content, const std::string &reply) {
    std::string id;
    try {
        auto enc = parvane::blobcrypt::encrypt(plain);
        if (enc.ciphertext.empty()) throw std::runtime_error("blobcrypt");
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_transport) throw std::runtime_error("нет сессии");
        parvane::CloudClient cloud(*g_transport);
        const auto filename = content.value("filename", content.value("kind", std::string("media")) + ".bin");
        const auto mime = content.value("mime", std::string("application/octet-stream"));
        auto recipients = std::vector<std::string>{toStd};
        if (isGroupLocked(toStd)) recipients = g_groupMembers[toStd];
        const auto fileId = cloud.upload(g_self, g_token, filename, mime, enc.ciphertext,
                                         recipients, false, 256 * 1024, 120000);
        if (fileId.empty()) throw std::runtime_error("блоб не загрузился");
        content["file_id"] = fileId;
        content["size_bytes"] = plain.size();
        content["file_key"] = enc.keyB64;
        content["file_nonce"] = enc.nonceB64;
        id = sendSealedLocked(toStd, content, reply.empty() ? std::nullopt : std::optional<std::string>(reply));
        // локальная копия под тем же file_id — X покажет сразу
        std::error_code ec; std::filesystem::create_directories(mediaDir(), ec);
        std::ofstream o(mediaDir() + "/" + fileId, std::ios::binary); o << plain;
        content["local_path"] = mediaDir() + "/" + fileId;
        emit(json{{"type", "message"}, {"id", id}, {"from", g_self}, {"to", toStd}, {"ts", nowSec()},
                  {"text", content.value("caption", std::string())}, {"out", true},
                  {"kind", content.value("kind", "")}, {"read", false}, {"content", content},
                  {"reply_to", reply.empty() ? json() : json(reply)}});
    } catch (const std::exception &e) {
        LOGE("sendMedia: %s", e.what());
        emitError(std::string("send: ") + e.what());
        return {};
    }
    LOGI("отправлено медиа %s → %s", id.c_str(), toStd.c_str());
    return id;
}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSendMedia(
        JNIEnv *env, jclass, jstring to, jstring path, jstring contentJson, jstring replyTo) {
    const auto pathStd = jstr(env, path);
    auto content = json::parse(jstr(env, contentJson), nullptr, false);
    std::ifstream f(pathStd, std::ios::binary);
    if (!content.is_object() || !f) { LOGE("sendMedia: битый content или файл не читается: %s", pathStd.c_str()); return env->NewStringUTF(""); }
    std::string plain((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    return env->NewStringUTF(sendMediaBytes(jstr(env, to), plain, content, jstr(env, replyTo)).c_str());
}
// Пересылка (паритет ForwardMediaReshared десктопа): текст — тот же content новому
// адресату; медиа — блоб скачивается (или берётся локальная копия) и перезаливается
// для нового получателя (у cloud список получателей на блоб). forwarded_name — автор.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeForward(
        JNIEnv *env, jclass, jstring to, jstring uuid) {
    const auto toStd = jstr(env, to), id = jstr(env, uuid);
    json inner;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        auto it = g_decCache.find(id);
        if (it == g_decCache.end()) { LOGE("forward: %s нет в кэше", id.c_str()); return env->NewStringUTF(""); }
        inner = it->second;
    }
    auto content = inner.value("content", json::object());
    if (!content.is_object()) return env->NewStringUTF("");
    const auto author = inner.value("from", std::string());
    if (!author.empty()) content["forwarded_name"] = author.substr(0, author.find('@'));
    content.erase("local_path");
    const auto fid = content.value("file_id", std::string());
    if (!fid.empty()) {
        std::string plain;
        const auto local = mediaDir() + "/" + fid;
        if (std::ifstream lf(local, std::ios::binary); lf) {
            plain.assign((std::istreambuf_iterator<char>(lf)), std::istreambuf_iterator<char>());
        } else {
            try {
                std::string self, token;
                { std::lock_guard<std::mutex> lk(g_mu); self = g_self; token = g_token; }
                auto own = makeTransport(token);
                parvane::CloudClient cloud(*own);
                auto d = cloud.download(self, token, fid, 120000);
                if (!d.ok) throw std::runtime_error(d.error);
                auto dec = parvane::blobcrypt::decrypt(d.bytes, content.value("file_key", std::string()), content.value("file_nonce", std::string()));
                if (!dec) throw std::runtime_error("blobcrypt: не расшифровался");
                plain = *dec;
            } catch (const std::exception &e) {
                LOGE("forward %s: блоб: %s", id.c_str(), e.what());
                return env->NewStringUTF("");
            }
        }
        for (const char *k : {"file_id", "file_key", "file_nonce", "size_bytes"}) content.erase(k);
        return env->NewStringUTF(sendMediaBytes(toStd, plain, content, "").c_str());
    }
    std::string nid;
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        nid = sendSealedLocked(toStd, content, std::nullopt);
        emit(json{{"type", "message"}, {"id", nid}, {"from", g_self}, {"to", toStd}, {"ts", nowSec()},
                  {"text", content.value("text", std::string())}, {"out", true}, {"kind", content.value("kind", "")},
                  {"read", false}, {"content", content}, {"reply_to", json()}});
    } catch (const std::exception &e) {
        LOGE("forward: %s", e.what());
        return env->NewStringUTF("");
    }
    LOGI("переслано %s → %s как %s", id.c_str(), toStd.c_str(), nid.c_str());
    return env->NewStringUTF(nid.c_str());
}
// Скачать блоб из cloud (с расшифровкой, если есть ключ) → путь файла ("" при ошибке).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeDownloadFile(
        JNIEnv *env, jclass, jstring fileId, jstring key, jstring nonce) {
    const auto fid = jstr(env, fileId);
    const auto k = jstr(env, key), n = jstr(env, nonce);
    const auto path = mediaDir() + "/" + fid;
    if (std::ifstream(path).good()) return env->NewStringUTF(path.c_str());
    try {
        std::unique_ptr<parvane::GatewayWsTransport> own; // отдельный транспорт: не держим g_mu на долгой загрузке
        std::string self, token;
        { std::lock_guard<std::mutex> lk(g_mu); self = g_self; token = g_token; }
        if (self.empty()) throw std::runtime_error("нет сессии");
        own = makeTransport(token);
        parvane::CloudClient cloud(*own);
        auto d = cloud.download(self, token, fid, 120000);
        if (!d.ok) throw std::runtime_error(d.error);
        std::string bytes = d.bytes;
        if (!k.empty()) {
            auto dec = parvane::blobcrypt::decrypt(d.bytes, k, n);
            if (!dec) throw std::runtime_error("blobcrypt: не расшифровался");
            bytes = *dec;
        }
        std::error_code ec; std::filesystem::create_directories(mediaDir(), ec);
        std::ofstream o(path, std::ios::binary); o << bytes;
        LOGI("файл %s скачан (%zu байт)", fid.c_str(), bytes.size());
    } catch (const std::exception &e) {
        LOGE("downloadFile %s: %s", fid.c_str(), e.what());
        return env->NewStringUTF("");
    }
    return env->NewStringUTF(path.c_str());
}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeListGroups(JNIEnv *env, jclass) {
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        return env->NewStringUTF(refreshGroupsLocked().dump().c_str());
    } catch (const std::exception &e) {
        LOGE("listGroups: %s", e.what());
        return env->NewStringUTF("[]");
    }
}
// Создать группу (kind group|channel) с участниками → group_id ("" при ошибке)
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeCreateGroup(
        JNIEnv *env, jclass, jstring name, jstring kind, jstring membersJson) {
    try {
        std::vector<std::string> members;
        auto arr = json::parse(jstr(env, membersJson), nullptr, false);
        if (arr.is_array()) for (const auto &m : arr) if (m.is_string()) members.push_back(m.get<std::string>());
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_transport) throw std::runtime_error("нет сессии");
        parvane::GroupClient gc(*g_transport);
        const auto r = gc.create(g_token, jstr(env, name), jstr(env, kind), members);
        if (!r.ok) throw std::runtime_error(r.error.empty() ? "группа не создана" : r.error);
        LOGI("группа создана %s", r.group_id.c_str());
        refreshGroupsLocked();
        return env->NewStringUTF(r.group_id.c_str());
    } catch (const std::exception &e) {
        LOGE("createGroup: %s", e.what());
        return env->NewStringUTF("");
    }
}
// Действие над группой: add|remove|rename|leave|remove_group (member/name в arg)
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupAction(
        JNIEnv *env, jclass, jstring groupId, jstring action, jstring arg) {
    const auto gid = jstr(env, groupId), act = jstr(env, action), a = jstr(env, arg);
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_transport) throw std::runtime_error("нет сессии");
        parvane::GroupClient gc(*g_transport);
        parvane::GroupActionResponse r;
        if (act == "add") r = gc.addMember(g_token, gid, a);
        else if (act == "remove") r = gc.removeMember(g_token, gid, a);
        else if (act == "leave") r = gc.removeMember(g_token, gid, g_self);
        else if (act == "rename") r = gc.rename(g_token, gid, a);
        else if (act == "remove_group") r = gc.remove(g_token, gid);
        else throw std::runtime_error("неизвестное действие " + act);
        if (!r.ok) throw std::runtime_error(r.error.empty() ? "отказ" : r.error);
        refreshGroupsLocked();
        return env->NewStringUTF("");
    } catch (const std::exception &e) {
        LOGE("groupAction %s %s: %s", act.c_str(), gid.c_str(), e.what());
        return env->NewStringUTF(e.what());
    }
}
// Настройки уведомлений → серверу (блоб веба {defaults, exceptions})
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeSetNotify(JNIEnv *env, jclass, jstring blob) {
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_messenger) throw std::runtime_error("нет сессии");
        g_messenger->setNotify(g_self, jstr(env, blob), g_token);
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("setNotify: %s", e.what());
        return JNI_FALSE;
    }
}
// Профиль в identity: {display_name, bio, birthday, phone, name_color, personal_channel}
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeSetProfile(JNIEnv *env, jclass, jstring fieldsJson) {
    try {
        auto req = json::parse(jstr(env, fieldsJson), nullptr, false);
        if (!req.is_object()) throw std::runtime_error("битые поля");
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_transport) throw std::runtime_error("нет сессии");
        req["token"] = g_token;
        const auto raw = g_transport->request("identity.user.setname", req.dump(), 5000);
        if (!json::parse(raw, nullptr, false).value("ok", false)) throw std::runtime_error("identity отказал");
        LOGI("профиль обновлён");
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("setProfile: %s", e.what());
        return JNI_FALSE;
    }
}
// Аватар: файл → cloud (публично, без шифра) → identity.user.setavatar; вернуть file_id
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSetAvatar(JNIEnv *env, jclass, jstring path) {
    try {
        std::ifstream f(jstr(env, path), std::ios::binary);
        if (!f) throw std::runtime_error("файл не читается");
        std::string bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_transport) throw std::runtime_error("нет сессии");
        parvane::CloudClient cloud(*g_transport);
        const auto fileId = cloud.upload(g_self, g_token, "avatar.jpg", "image/jpeg", bytes, {}, true, 256 * 1024, 60000);
        if (fileId.empty()) throw std::runtime_error("cloud не принял");
        g_transport->request("identity.user.setavatar", json{{"token", g_token}, {"file_id", fileId}}.dump(), 5000);
        std::error_code ec; std::filesystem::create_directories(mediaDir(), ec);
        std::ofstream o(mediaDir() + "/" + fileId, std::ios::binary); o << bytes;
        LOGI("аватар обновлён (%s)", fileId.c_str());
        return env->NewStringUTF(fileId.c_str());
    } catch (const std::exception &e) {
        LOGE("setAvatar: %s", e.what());
        return env->NewStringUTF("");
    }
}
// Скрыть «для меня» (очистка/удаление чата): msg.chat.clear пачками ≤500
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeClearMessages(JNIEnv *env, jclass, jstring idsJson) {
    try {
        auto arr = json::parse(jstr(env, idsJson), nullptr, false);
        std::vector<std::string> ids;
        if (arr.is_array()) for (const auto &v : arr) if (v.is_string()) ids.push_back(v.get<std::string>());
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_messenger) throw std::runtime_error("нет сессии");
        for (size_t i = 0; i < ids.size(); i += parvane::MessengerClient::kClearMaxIds) {
            std::vector<std::string> chunk(ids.begin() + i, ids.begin() + std::min(ids.size(), i + parvane::MessengerClient::kClearMaxIds));
            g_messenger->clearMessages(g_self, chunk, g_token);
        }
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("clearMessages: %s", e.what());
        return JNI_FALSE;
    }
}
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeSendTyping(JNIEnv *env, jclass, jstring to) {
    const auto toStd = jstr(env, to);
    std::lock_guard<std::mutex> lk(g_mu);
    if (!g_transport) return;
    try { g_transport->publish("msg.typing." + std::to_string(idForAddress(toStd)), json{{"from", g_self}, {"to", toStd}}.dump()); } catch (...) {}
}
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeEdit(
        JNIEnv *env, jclass, jstring uuid, jstring to, jstring contentJson) {
    const auto id = jstr(env, uuid), toStd = jstr(env, to);
    try {
        auto content = json::parse(jstr(env, contentJson), nullptr, false);
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_messenger || !g_transport || !parvane::e2e::ready()) throw std::runtime_error("нет сессии");
        const auto sealed = parvane::e2e::sealForAddress(toStd, content.dump(), *g_transport, g_token);
        if (!sealed) throw std::runtime_error("E2E: нет устройств получателя");
        auto copies = json::array();
        for (const auto &c : sealed->copies) copies.push_back(c.toJson());
        const auto sig = parvane::e2e::sign("edit:" + id + ":" + sealed->content.value("ciphertext", std::string()));
        g_messenger->editContent(g_self, id, sealed->content, sig, copies, g_token);
        g_decCache[id] = json{{"from", g_self}, {"content", content}};
        LOGI("правка msg %s", id.c_str());
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("edit: %s", e.what());
        return JNI_FALSE;
    }
}
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeDelete(JNIEnv *env, jclass, jstring uuid) {
    const auto id = jstr(env, uuid);
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_messenger) throw std::runtime_error("нет сессии");
        g_messenger->deleteMessage(g_self, id, g_token, parvane::e2e::sign("delete:" + id));
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("delete: %s", e.what());
        return JNI_FALSE;
    }
}
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeReact(JNIEnv *env, jclass, jstring uuid, jstring emoji) {
    const auto id = jstr(env, uuid), em = jstr(env, emoji);
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_messenger) throw std::runtime_error("нет сессии");
        g_messenger->react(g_self, id, em, g_token, parvane::e2e::sign("react:" + id + ":" + em));
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("react: %s", e.what());
        return JNI_FALSE;
    }
}
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativePin(JNIEnv *env, jclass, jstring uuid, jboolean pinned) {
    const auto id = jstr(env, uuid);
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_messenger) throw std::runtime_error("нет сессии");
        g_messenger->pin(g_self, id, pinned == JNI_TRUE, g_token, parvane::e2e::sign("pin:" + id + ":" + (pinned ? "true" : "false")));
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("pin: %s", e.what());
        return JNI_FALSE;
    }
}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeResolve(
        JNIEnv *env, jclass, jstring addressesJson) {
    try {
        auto arr = json::parse(jstr(env, addressesJson), nullptr, false);
        if (!arr.is_array()) arr = json::array();
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_transport) throw std::runtime_error("нет сессии");
        const auto raw = g_transport->request("identity.user.resolve",
                                              json{{"token", g_token}, {"usernames", arr}}.dump(), 5000);
        return env->NewStringUTF(raw.c_str());
    } catch (const std::exception &e) {
        LOGE("resolve: %s", e.what());
        return env->NewStringUTF("{\"users\":[]}");
    }
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSearch(
        JNIEnv *env, jclass, jstring query) {
    try {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_transport) throw std::runtime_error("нет сессии");
        const auto raw = g_transport->request("identity.user.search",
                                              json{{"token", g_token}, {"query", jstr(env, query)}}.dump(), 5000);
        return env->NewStringUTF(raw.c_str());
    } catch (const std::exception &e) {
        LOGE("search: %s", e.what());
        return env->NewStringUTF("{\"users\":[]}");
    }
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeMarkRead(JNIEnv *env, jclass, jstring uuid) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (g_messenger) g_messenger->markRead(g_self, jstr(env, uuid), g_token);
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSelf(JNIEnv *env, jclass) {
    std::lock_guard<std::mutex> lk(g_mu);
    return env->NewStringUTF(g_self.c_str());
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeReplayJournal(JNIEnv *, jclass) {
    journalReplay();
}
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeLogout(JNIEnv *, jclass) {
    g_presenceRunning = false;
    std::lock_guard<std::mutex> lk(g_mu);
    g_running = false;
    g_messenger.reset();
    if (g_transport) g_transport->close();
    g_transport.reset();
    g_self.clear();
    g_token.clear();
    g_seen.clear();
    std::remove(sessionPath().c_str());
    std::remove(cursorsPath().c_str());
    std::remove(journalPath().c_str());
}

} // extern "C"
