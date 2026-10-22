// Parvane Android (spec 031): пробуждение в фоне — регистрация канала UnifiedPush (видом WEB_PUSH: коннектор
// даёт ключи p256dh/auth, сервер шлёт RFC 8291/8292 — сервер не меняется) и будильники «Плана» (push.alarm.set:
// серверу только моменты). Пробуждение пустое: ни собеседника, ни текста сервер не знает.
#include "jni_internal.h"

namespace pvjni {
namespace {

json call(const std::string &method, const json &request) {
    const auto c = control();
    if (!c) throw std::runtime_error("нет соединения управления");
    return c->call(method, request);
}

} // namespace
} // namespace pvjni

using namespace pvjni;

extern "C" {

// {"vapid": base64 (65 байт), "supported": ["WAKE_KIND_WEB_PUSH", …]} | {"error_code"}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvanePush_nativeDescribe(JNIEnv *env, jclass) {
    try {
        const auto r = call("push.wake.describe", json::object());
        const auto *vapid = parvane::v2::field(r, "vapidPublicKey", "vapid_public_key");
        const auto *supported = parvane::v2::field(r, "supported", "supported");
        return jreply(env, json{{"vapid", vapid && vapid->is_string() ? vapid->get<std::string>() : std::string()},
                                {"supported", supported && supported->is_array() ? *supported : json::array()}});
    } catch (const std::exception &e) {
        return jreply(env, jfail(errorCodeOf(e), e.what()));
    }
}

// kind — "WAKE_KIND_WEB_PUSH" | "WAKE_KIND_UNIFIED_PUSH"; ключи — base64 (стандартный алфавит).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvanePush_nativeRegister(
        JNIEnv *env, jclass, jstring kind, jstring endpoint, jstring p256dh, jstring auth) {
    try {
        json reg{{"kind", jstr(env, kind)}, {"endpoint", jstr(env, endpoint)}};
        if (const auto k = jstr(env, p256dh); !k.empty()) reg["p256dh"] = k;
        if (const auto a = jstr(env, auth); !a.empty()) reg["auth"] = a;
        (void)call("push.wake.register", json{{"registration", reg}});
        LOGI("пробуждение: канал зарегистрирован");
        return jreply(env, json{{"ok", true}});
    } catch (const std::exception &e) {
        LOGE("пробуждение: регистрация не удалась: %s", e.what());
        return jreply(env, jfail(errorCodeOf(e), e.what()));
    }
}

// Пустой endpoint — снять все каналы этого устройства.
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvanePush_nativeUnregister(JNIEnv *env, jclass, jstring endpoint) {
    try {
        (void)call("push.wake.unregister", json{{"endpoint", jstr(env, endpoint)}});
        return JNI_TRUE;
    } catch (const std::exception &) {
        return JNI_FALSE;
    }
}

// Моменты будильника (мс unix, ≤ 64, не дальше 31 дня) — заменяют прежний список устройства.
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvanePush_nativeSetAlarms(JNIEnv *env, jclass, jstring atMsJson) {
    try {
        const auto arr = json::parse(jstr(env, atMsJson), nullptr, false);
        auto at = json::array();
        if (arr.is_array())
            for (const auto &v : arr)
                if (v.is_number_integer() && at.size() < 64) at.push_back(std::to_string(v.get<std::int64_t>()));
        (void)call("push.alarm.set", json{{"at_ms", at}});
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("будильник: %s", e.what());
        return JNI_FALSE;
    }
}

} // extern "C"
