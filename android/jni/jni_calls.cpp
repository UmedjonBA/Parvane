// Parvane Android (spec 031): звонки — личные (CallManager ядра) и групповые mesh ≤ 8 (GroupCallManager), сигналы
// только запечатанными конвертами v2 (CALL-1, CALL-2). Медиа — org.webrtc из состава Telegram X в Kotlin
// (ParvaneCalls): MediaBackend ядра здесь — тонкий мост по числовому дескриптору соединения.
#include "jni_internal.h"

#include <parvane/call.h>
#include <parvane/call_manager.h>
#include <parvane/crypto.h>
#include <parvane/group_call_manager.h>

#include <algorithm>
#include <condition_variable>
#include <map>
#include <thread>
#include <vector>

namespace pvjni {

namespace {

std::atomic<jclass> g_callsClass{nullptr}; // org.parvane.core.ParvaneCalls (пишет поток Kotlin, читают потоки ядра)

// Вызов статического метода ParvaneCalls (любой поток; аттач к VM).
template <typename F>
void withEnv(F &&f) {
    if (!g_vm || !g_callsClass) return;
    JNIEnv *env = nullptr;
    bool attached = false;
    if (g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK) {
        if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
        attached = true;
    }
    f(env);
    if (env->ExceptionCheck()) { env->ExceptionDescribe(); env->ExceptionClear(); }
    if (attached) g_vm->DetachCurrentThread();
}

void callStatic(const char *name, const char *sig, std::int64_t handle, const std::string *a = nullptr,
                const std::string *b = nullptr, int i = 0, bool z = false) {
    withEnv([&](JNIEnv *env) {
        const auto m = env->GetStaticMethodID(g_callsClass, name, sig);
        if (!m) { env->ExceptionClear(); return; }
        const std::string s(sig);
        if (s == "(J)V") env->CallStaticVoidMethod(g_callsClass, m, jlong(handle));
        else if (s == "(JZ)V") env->CallStaticVoidMethod(g_callsClass, m, jlong(handle), jboolean(z));
        else if (s == "(JLjava/lang/String;)V") {
            auto ja = parvane::jniutf::toJava(env, *a);
            env->CallStaticVoidMethod(g_callsClass, m, jlong(handle), ja);
            env->DeleteLocalRef(ja);
        } else if (s == "(JLjava/lang/String;Ljava/lang/String;I)V") {
            auto ja = parvane::jniutf::toJava(env, *a);
            auto jb = parvane::jniutf::toJava(env, *b);
            env->CallStaticVoidMethod(g_callsClass, m, jlong(handle), ja, jb, jint(i));
            env->DeleteLocalRef(ja);
            env->DeleteLocalRef(jb);
        }
    });
}

// Мост MediaBackend ↔ Kotlin: дескриптор → объект (колбэки Kotlin находят его по дескриптору).
// NAT-06: колбэк Kotlin (поток наблюдателя WebRTC) может прийти, пока ядро разрушает мост (отбой, выход участника
// из сетки). Мост знает, сколько колбэков идёт сейчас, и деструктор ждёт их (кроме колбэка своего же потока: ядро
// может завершить звонок прямо из него — тогда после возврата объект уже не трогается).
class JniMediaBackend;
struct MediaSlot {
    JniMediaBackend *backend = nullptr;
    int inflight = 0;
    bool dead = false;
};
std::mutex g_mediaMu;
std::condition_variable g_mediaCv;
std::map<std::int64_t, MediaSlot> g_media;
std::atomic<std::int64_t> g_nextHandle{1};
thread_local std::vector<std::int64_t> t_mediaCallbacks; // дескрипторы, чей колбэк идёт на этом потоке

class JniMediaBackend : public parvane::MediaBackend {
public:
    JniMediaBackend() : handle_(g_nextHandle++) {
        {
            std::lock_guard<std::mutex> lk(g_mediaMu);
            g_media[handle_].backend = this;
        }
        callStatic("mediaCreate", "(J)V", handle_);
    }
    ~JniMediaBackend() override {
        {
            std::unique_lock<std::mutex> lk(g_mediaMu);
            const auto own = static_cast<int>(std::count(t_mediaCallbacks.begin(), t_mediaCallbacks.end(), handle_));
            if (const auto it = g_media.find(handle_); it != g_media.end()) {
                it->second.dead = true;
                g_mediaCv.wait(lk, [&] {
                    const auto cur = g_media.find(handle_);
                    return cur == g_media.end() || cur->second.inflight <= own;
                });
                g_media.erase(handle_);
            }
        }
        callStatic("mediaClose", "(J)V", handle_);
    }
    void createOffer(std::function<void(std::string)> onOffer) override {
        {
            std::lock_guard<std::mutex> lk(mu_);
            onOffer_ = std::move(onOffer);
        }
        callStatic("mediaCreateOffer", "(J)V", handle_);
    }
    void acceptOffer(const std::string &remoteSdp, std::function<void(std::string)> onAnswer) override {
        {
            std::lock_guard<std::mutex> lk(mu_);
            onAnswer_ = std::move(onAnswer);
        }
        callStatic("mediaAcceptOffer", "(JLjava/lang/String;)V", handle_, &remoteSdp);
    }
    void setRemoteAnswer(const std::string &sdp) override {
        callStatic("mediaSetRemoteAnswer", "(JLjava/lang/String;)V", handle_, &sdp);
    }
    void addRemoteIce(const std::string &candidate) override {
        const auto c = parvane::parseIceCandidate(candidate);
        if (!c) return;
        callStatic("mediaAddIce", "(JLjava/lang/String;Ljava/lang/String;I)V", handle_, &c->sdp, &c->mid, c->mlineIndex);
    }
    void close() override { callStatic("mediaClose", "(J)V", handle_); }
    void setWantVideo(bool on) override { callStatic("mediaSetVideo", "(JZ)V", handle_, nullptr, nullptr, 0, on); }
    void setMuted(bool muted) override { callStatic("mediaSetMuted", "(JZ)V", handle_, nullptr, nullptr, 0, muted); }

    void localOffer(const std::string &sdp) {
        std::function<void(std::string)> f;
        {
            std::lock_guard<std::mutex> lk(mu_);
            f = std::move(onOffer_);
        }
        if (f) f(sdp);
    }
    void localAnswer(const std::string &sdp) {
        std::function<void(std::string)> f;
        {
            std::lock_guard<std::mutex> lk(mu_);
            f = std::move(onAnswer_);
        }
        if (f) f(sdp);
    }
    // Копия колбэка ядра: вызов может разрушить этот объект (отбой из обработчика)
    void localIce(const std::string &sdp, const std::string &mid, int index) {
        const auto cb = onLocalIce;
        if (cb) cb(parvane::iceCandidateJson(parvane::IceCandidate{sdp, mid, index}));
    }
    void connection(bool connected) {
        const auto cb = onConnectionChange;
        if (cb) cb(connected);
    }

private:
    std::int64_t handle_;
    std::mutex mu_;
    std::function<void(std::string)> onOffer_;
    std::function<void(std::string)> onAnswer_;
};

template <typename F>
void withMedia(std::int64_t handle, F &&f) {
    // Колбэк ядра зовётся без g_mediaMu (сессия звонка берёт свои замки)
    JniMediaBackend *b = nullptr;
    {
        std::lock_guard<std::mutex> lk(g_mediaMu);
        const auto it = g_media.find(handle);
        if (it == g_media.end() || it->second.dead || !it->second.backend) return;
        b = it->second.backend;
        ++it->second.inflight;
    }
    t_mediaCallbacks.push_back(handle);
    try {
        f(*b);
    } catch (const std::exception &e) {
        LOGE("медиа звонка: %s", e.what());
    }
    t_mediaCallbacks.pop_back();
    {
        std::lock_guard<std::mutex> lk(g_mediaMu);
        if (const auto it = g_media.find(handle); it != g_media.end()) --it->second.inflight;
    }
    g_mediaCv.notify_all();
}

std::mutex g_callMu;
std::shared_ptr<parvane::CallManager> g_call;
std::shared_ptr<parvane::GroupCallManager> g_groupCall;
std::unique_ptr<parvane::crypto::SigningKey> g_callKey;
// Ключ прежнего аккаунта не освобождается: менеджеры звонков держат на него сырой указатель и могут доживать в
// чужих потоках; новому аккаунту — новый ключ (файл callkey.txt стирается при выходе).
std::vector<std::unique_ptr<parvane::crypto::SigningKey>> g_retiredCallKeys;
std::atomic<bool> g_callsNobody{false};

const char *stateName(parvane::CallState s) {
    switch (s) {
    case parvane::CallState::Idle: return "idle";
    case parvane::CallState::Outgoing: return "outgoing";
    case parvane::CallState::Incoming: return "incoming";
    case parvane::CallState::Connecting: return "connecting";
    case parvane::CallState::Active: return "active";
    case parvane::CallState::Ended: return "ended";
    }
    return "idle";
}

std::shared_ptr<parvane::CallManager> callManager() {
    std::lock_guard<std::mutex> lk(g_callMu);
    return g_call;
}

std::shared_ptr<parvane::GroupCallManager> groupCallManager() {
    std::lock_guard<std::mutex> lk(g_callMu);
    return g_groupCall;
}

void ensureManagers() {
    std::lock_guard<std::mutex> lk(g_callMu);
    if (g_call) return;
    const auto me = self();
    if (me.empty()) return;
    if (!g_callKey) g_callKey = std::make_unique<parvane::crypto::SigningKey>(
        parvane::crypto::SigningKey::loadOrCreate(storeDir() + "/callkey.txt"));
    const auto makeBackend = [] { return std::unique_ptr<parvane::MediaBackend>(std::make_unique<JniMediaBackend>()); };
    parvane::CallManager::Callbacks ccb;
    ccb.sendV2 = [](const std::string &peer, const json &signal) {
        const auto s = v2Ready();
        std::string error;
        if (!s || !s->sendCallSignal(peer, signal, std::string(), &error)) return false;
        if (!error.empty() && signal.value("type", std::string()) == "invite") {
            // Вызов не ушёл: не висеть «звоним», сказать причину (T148)
            emit(json{{"type", "call"}, {"state", "failed"}, {"peer", peer}, {"error_code", error}});
            runDetached([] { if (const auto m = callManager()) m->hangup(); });
        }
        return true;
    };
    ccb.onIncoming = [](std::string peer, std::string media) {
        LOGI("входящий звонок (%s)", media.c_str());
        if (g_callsNobody) { // «Звонки — никто» (FR-040): как от заблокированного
            runDetached([] { if (const auto m = callManager()) m->hangup(); });
            return;
        }
        emit(json{{"type", "call"}, {"state", "incoming"}, {"peer", peer}, {"video", media == "video"}});
    };
    ccb.onState = [](parvane::CallState s) {
        // «incoming» уже пришло из onIncoming с собеседником; без него шов завёл бы второй звонок с пустым адресом
        if (s == parvane::CallState::Incoming) return;
        emit(json{{"type", "call"}, {"state", stateName(s)}});
    };
    ccb.onMediaState = [](const std::string &peer, bool audioMuted, bool videoMuted) {
        emit(json{{"type", "call"}, {"state", "media"}, {"peer", peer}, {"audio_muted", audioMuted}, {"video_muted", videoMuted}});
    };
    g_call = std::make_shared<parvane::CallManager>(me, g_callKey.get(), makeBackend, std::move(ccb));

    parvane::GroupCallManager::Callbacks gcb;
    gcb.asyncSend = true;
    gcb.sendV2 = [](const std::string &peer, const json &signal, const std::string &groupCallId) {
        const auto s = v2Ready();
        return s && s->sendCallSignal(peer, signal, groupCallId);
    };
    gcb.onPeerState = [](std::string peer, parvane::CallState s) {
        emit(json{{"type", "group_call"}, {"state", "peer"}, {"peer", peer}, {"peer_state", stateName(s)}});
    };
    gcb.onMediaState = [](const std::string &peer, bool audioMuted, bool videoMuted) {
        emit(json{{"type", "group_call"}, {"state", "media"}, {"peer", peer}, {"audio_muted", audioMuted}, {"video_muted", videoMuted}});
    };
    gcb.onInvite = [](const std::string &from, const std::string &gcid, const std::vector<std::string> &participants,
                      const std::string &media, const std::string &group, const std::string &title) {
        if (g_callsNobody) {
            runDetached([] { if (const auto g = groupCallManager()) (void)g->declineInvite(); });
            return;
        }
        emit(json{{"type", "group_call"}, {"state", "invite"}, {"from", from}, {"call_id", gcid}, {"participants", participants},
                  {"video", media == "video"}, {"group", group}, {"title", parvane::v2::cleanGroupTitle(title)}});
        runDetached([gcid] {
            std::this_thread::sleep_for(std::chrono::seconds(45));
            if (const auto g = groupCallManager()) g->expireInvite(gcid);
        });
    };
    gcb.onInviteClosed = [](const std::string &gcid) { emit(json{{"type", "group_call"}, {"state", "invite_closed"}, {"call_id", gcid}}); };
    gcb.onPeerDeclined = [](const std::string &peer, const std::string &reason) {
        emit(json{{"type", "group_call"}, {"state", "declined"}, {"peer", peer}, {"reason", reason}});
    };
    gcb.isBusy = [] {
        const auto m = callManager();
        const auto st = m ? m->state() : parvane::CallState::Idle;
        return st != parvane::CallState::Idle && st != parvane::CallState::Ended;
    };
    g_groupCall = std::make_shared<parvane::GroupCallManager>(me, g_callKey.get(), makeBackend, std::move(gcb));
}

// spec 024: своим устройствам — «принят/отклонён здесь», они перестают звонить.
void notifyOwnDevices(const std::string &callId, const char *reason) {
    if (callId.empty()) return;
    if (const auto s = v2Ready()) {
        if (!s->sendCallSignalOwn(parvane::rejectSignal(callId, reason))) LOGE("своим устройствам о звонке не сообщено");
    }
}

} // namespace

// Сигнал от сессии v2 (событие call_signal шва обходит Kotlin: сразу в менеджер).
void handleCallSignal(const std::string &from, bool group, const json &signal) {
    ensureManagers();
    if (from.empty() || !signal.is_object()) return;
    if (group) {
        if (const auto g = groupCallManager()) g->handleV2Signal(from, signal);
    } else if (const auto m = callManager()) {
        m->handleV2Signal(from, signal);
    }
}

void resetCalls() {
    std::shared_ptr<parvane::CallManager> m;
    std::shared_ptr<parvane::GroupCallManager> g;
    {
        std::lock_guard<std::mutex> lk(g_callMu);
        m = std::move(g_call);
        g = std::move(g_groupCall);
        if (g_callKey) g_retiredCallKeys.push_back(std::move(g_callKey));
    }
    if (m) m->hangup();
    if (g) g->leave();
}

} // namespace pvjni

using namespace pvjni;

extern "C" {

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeInit(JNIEnv *env, jclass cls) {
    if (!g_callsClass) g_callsClass = static_cast<jclass>(env->NewGlobalRef(cls));
}

// ICE-серверы (call.ice_config, временные учётные данные TURN): {"servers":[{urls,username,credential}],"ttl"}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCalls_nativeIceConfig(JNIEnv *env, jclass) {
    json out{{"servers", json::array()}, {"ttl", 0}};
    if (const auto c = control()) {
        try {
            const auto cfg = parvane::v2::account::iceConfig(*c);
            for (const auto &s : cfg.servers) out["servers"].push_back(json{{"urls", s.urls}, {"username", s.username}, {"credential", s.credential}});
            out["ttl"] = cfg.ttlSecs;
        } catch (const std::exception &e) {
            LOGE("ice_config: %s", e.what());
        }
    }
    return jreply(env, out);
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativePlace(JNIEnv *env, jclass, jstring peer, jboolean video) {
    ensureManagers();
    const auto p = jstr(env, peer);
    const bool v = video == JNI_TRUE;
    runDetached([p, v] { if (const auto m = callManager()) m->placeCall(p, v ? "video" : "audio"); });
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeAccept(JNIEnv *, jclass) {
    runDetached([] {
        if (const auto g = groupCallManager()) {
            if (const auto gcid = g->pendingInviteId(); !gcid.empty()) {
                notifyOwnDevices(gcid, "answered_elsewhere");
                (void)g->acceptInvite();
                return;
            }
        }
        if (const auto m = callManager()) {
            if (m->state() == parvane::CallState::Incoming) notifyOwnDevices(m->callId(), "answered_elsewhere");
            m->accept();
        }
    });
}

// Отбой/отклонение текущего (личного, группового или приглашения в групповой).
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeHangup(JNIEnv *, jclass) {
    runDetached([] {
        if (const auto g = groupCallManager()) {
            if (const auto gcid = g->pendingInviteId(); !gcid.empty()) {
                notifyOwnDevices(gcid, "declined");
                (void)g->declineInvite();
                return;
            }
            if (!g->groupCallId().empty()) {
                g->leave();
                emit(json{{"type", "group_call"}, {"state", "left"}});
                return;
            }
        }
        if (const auto m = callManager()) {
            if (m->state() == parvane::CallState::Incoming) notifyOwnDevices(m->callId(), "declined"); // отклонён, а не пропущен
            m->hangup();
        }
    });
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeSetMuted(JNIEnv *, jclass, jboolean muted, jboolean videoOff) {
    const bool mu = muted == JNI_TRUE, vo = videoOff == JNI_TRUE;
    runDetached([mu, vo] {
        if (const auto m = callManager()) {
            m->setMuted(mu);
            m->sendMediaState(mu, vo);
        }
        if (const auto g = groupCallManager(); g && !g->groupCallId().empty()) g->sendMediaState(mu, vo);
    });
}

// Групповой звонок группы: participants — участники (вместе с собой), group/title — CALL-2.
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeGroupStart(
        JNIEnv *env, jclass, jstring participantsJson, jboolean video, jstring group, jstring title) {
    try {
        ensureManagers();
        std::vector<std::string> parts;
        const auto arr = json::parse(jstr(env, participantsJson), nullptr, false);
        if (arr.is_array()) for (const auto &p : arr) if (p.is_string()) parts.push_back(p.get<std::string>());
        const auto g = jstr(env, group), t = jstr(env, title);
        const bool v = video == JNI_TRUE;
        runDetached([parts, v, g, t] {
            if (const auto gm = groupCallManager()) gm->startCall(parvane::v2::newUuidV7(), parts, v ? "video" : "audio", g, t);
        });
    } catch (const std::exception &e) {
        LOGE("nativeGroupStart: %s", e.what());
    }
}

// id текущего личного звонка (UUID; "" — звонка нет). Не из колбэка состояния (мьютекс менеджера).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCalls_nativeCallId(JNIEnv *env, jclass) {
    const auto m = callManager();
    return jout(env, m ? m->callId() : std::string());
}

// Приглашение в групповой звонок: «Принять» — вход в сетку, «Отклонить» — отказ всем участникам.
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeGroupAccept(JNIEnv *, jclass) {
    runDetached([] { if (const auto g = groupCallManager()) (void)g->acceptInvite(); });
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeGroupDecline(JNIEnv *, jclass) {
    runDetached([] { if (const auto g = groupCallManager()) (void)g->declineInvite(); });
}

// Свой микрофон/камера в групповом звонке — участникам сигналом media (сами дорожки глушит Kotlin).
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeGroupMediaState(JNIEnv *, jclass, jboolean audioMuted, jboolean videoMuted) {
    const bool a = audioMuted == JNI_TRUE, v = videoMuted == JNI_TRUE;
    runDetached([a, v] { if (const auto g = groupCallManager()) g->sendMediaState(a, v); });
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeGroupLeave(JNIEnv *, jclass) {
    runDetached([] { if (const auto g = groupCallManager()) g->leave(); });
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeSetCallsNobody(JNIEnv *, jclass, jboolean nobody) {
    g_callsNobody = nobody == JNI_TRUE;
}

// Kotlin (org.webrtc) → ядро: локальный SDP/ICE и состояние соединения по дескриптору.
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeLocalOffer(JNIEnv *env, jclass, jlong handle, jstring sdp) {
    const auto s = jstr(env, sdp);
    withMedia(handle, [&](JniMediaBackend &b) { b.localOffer(s); });
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeLocalAnswer(JNIEnv *env, jclass, jlong handle, jstring sdp) {
    const auto s = jstr(env, sdp);
    withMedia(handle, [&](JniMediaBackend &b) { b.localAnswer(s); });
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeLocalIce(JNIEnv *env, jclass, jlong handle, jstring sdp, jstring mid, jint index) {
    const auto s = jstr(env, sdp), m = jstr(env, mid);
    withMedia(handle, [&](JniMediaBackend &b) { b.localIce(s, m, index); });
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCalls_nativeConnection(JNIEnv *, jclass, jlong handle, jboolean connected) {
    withMedia(handle, [&](JniMediaBackend &b) { b.connection(connected == JNI_TRUE); });
}

} // extern "C"
