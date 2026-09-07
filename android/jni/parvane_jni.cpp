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
#include <android/log.h>

#include <parvane/e2e.h>
#include <parvane/events.h>
#include <parvane/gateway_ws_transport.h>
#include <parvane/messenger.h>
#include <parvane/messenger_client.h>
#include <parvane/topics.h>

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <fstream>
#include <memory>
#include <mutex>
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

std::string jstr(JNIEnv *env, jstring s) {
    if (!s) return {};
    const char *c = env->GetStringUTFChars(s, nullptr);
    std::string out = c ? c : "";
    env->ReleaseStringUTFChars(s, c);
    return out;
}

// Событие в Kotlin: аттачим поток к VM (pump/inbox — нативные потоки).
void emit(const json &event) {
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
    if (env->ExceptionCheck()) env->ExceptionClear();
    if (attached) g_vm->DetachCurrentThread();
}

void emitError(const std::string &text) { emit(json{{"type", "error"}, {"text", text}}); }

std::string sessionPath() { return g_storeDir + "/session.json"; }
std::string cursorsPath() { return g_storeDir + "/cursors.json"; }
std::string e2eDir(const std::string &self) { return g_storeDir + "/e2e-" + self; }

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
void deliverStored(parvane::StoredMessage sm, bool live) {
    if (sm.id.empty() || g_seen.count(sm.id)) return;
    std::string author = sm.from;
    if (parvane::contentKind(sm.content) == "encrypted") {
        const auto senderIdentity = sm.content.value("sender_identity", std::string());
        const auto dec = parvane::e2e::open(sm.from, sm.content.dump());
        if (dec.empty()) {
            LOGE("не расшифровано %s", sm.id.c_str());
            if (live && g_messenger) g_messenger->ack(g_self, sm.id, g_token, sm.from);
            return;
        }
        auto inner = json::parse(dec, nullptr, false);
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
    } else if (parvane::contentKind(sm.content) == "group_encrypted") {
        return; // группы — следующий этап
    }
    g_seen.insert(sm.id);
    const bool out = (author == g_self);
    const auto text = sm.text();
    emit(json{{"type", "message"}, {"id", sm.id}, {"from", author}, {"to", sm.to},
              {"ts", sm.ts}, {"text", text ? *text : ""}, {"out", out},
              {"kind", parvane::contentKind(sm.content)}, {"read", sm.read}});
    if (live && !out && g_messenger) g_messenger->ack(g_self, sm.id, g_token, author);
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
            {
                std::lock_guard<std::mutex> lk(g_mu);
                if (!g_messenger) break;
                page = g_messenger->sync(g_self, g_token, g_cursorId, g_cursorUpd, 15000,
                                         parvane::e2e::ready() ? &auth : nullptr, &readIds);
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

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeServerDomain(JNIEnv *env, jclass) {
    return env->NewStringUTF(serverDomain().c_str());
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeLogin(
        JNIEnv *env, jclass, jstring user, jstring password) {
    json out{{"ok", false}};
    try {
        auto address = jstr(env, user);
        if (address.find('@') == std::string::npos) {
            const auto domain = serverDomain();
            if (domain.empty()) throw std::runtime_error("сервер недоступен");
            address += "@" + domain;
        }
        parvane::IssueRequest req{address, jstr(env, password)};
        req.deviceId = parvane::e2e::ensureDeviceId(e2eDir(address));
        auto t = makeTransport("");
        const auto raw = t->request(parvane::topics::IdentityIssue, req.toJson().dump(), 8000);
        const auto resp = parvane::IssueResponse::fromJson(json::parse(raw));
        if (!resp.ok || !resp.token) {
            out["error"] = resp.error.value_or("неверный логин или пароль");
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

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeStartSession(JNIEnv *, jclass) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (g_messenger) return JNI_TRUE;
    if (g_self.empty() || g_token.empty()) return JNI_FALSE;
    try {
        g_transport = makeTransport(g_token);
        g_messenger = std::make_unique<parvane::MessengerClient>(*g_transport);
        parvane::e2e::initDevice(*g_transport, g_self, g_token, e2eDir(g_self));
        loadCursors();
        g_messenger->onInbox(g_self, [](parvane::StoredMessage sm) { deliverStored(std::move(sm), true); });
        g_messenger->onDelivered(g_self, [](std::string id) {
            emit(json{{"type", "delivered"}, {"id", id}});
        });
        g_messenger->onReadNotice(g_self, [](std::vector<std::string> ids) {
            emit(json{{"type", "read"}, {"ids", ids}});
        });
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
    emit(json{{"type", "message"}, {"id", id}, {"from", g_self}, {"to", toStd},
              {"ts", std::chrono::duration_cast<std::chrono::seconds>(
                         std::chrono::system_clock::now().time_since_epoch()).count()},
              {"text", body}, {"out", true}, {"kind", "text"}, {"read", false}});
    return env->NewStringUTF(id.c_str());
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

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeLogout(JNIEnv *, jclass) {
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
}

} // extern "C"
