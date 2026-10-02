// Parvane Android: JNI движка протокола v2 без сети (spec 007, T067) —
// org.parvane.core.ParvaneProtocol. Входит в libparvane_jni.so на устройстве
// и в хостовую libparvane_protocol_jni.so для JVM-тестов шва
// (android/build-host-jni.sh): общие векторы conformance через C ABI движка
// (pv_run_conformance_vectors) и отображение событий v2 → события ядра.
#include <jni.h>

#include <parvane_protocol.h>

#include <parvane/v2_content.h>
#include <parvane/v2_engine.h>

#include "jni_utf.h"
#include "v2_bridge.h"

#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

namespace {

std::string jstr(JNIEnv *env, jstring s) { return parvane::jniutf::fromJava(env, s); }

jstring jout(JNIEnv *env, const json &j) { return parvane::jniutf::toJava(env, j.dump()); }

} // namespace

extern "C" {

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneProtocol_nativeEngineVersion(JNIEnv *env, jclass) {
    return jout(env, json{{"version", parvane::v2::engineVersion()}, {"major", parvane::v2::protocolMajor()}});
}

// Набор векторов → {"cases": n} или {"cases": -1, "error": "…"}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneProtocol_nativeRunConformanceVectors(
        JNIEnv *env, jclass, jstring suite, jstring vectorsJson) {
    const auto s = jstr(env, suite), j = jstr(env, vectorsJson);
    char *err = nullptr;
    const auto n = pv_run_conformance_vectors(s.c_str(), j.c_str(), &err);
    json out{{"cases", n}};
    if (err) {
        out["error"] = std::string(err);
        parvane_protocol_string_free(err);
    }
    return jout(env, out);
}

// Событие движка → {"incoming": {…}, "event": событие ядра | null}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneProtocol_nativeInterpretDirect(
        JNIEnv *env, jclass, jstring eventJson, jstring self) {
    const auto ev = json::parse(jstr(env, eventJson), nullptr, false);
    const auto me = jstr(env, self);
    const auto in = parvane::v2::interpretDirect(ev.is_discarded() ? json() : ev, me);
    json out{{"incoming", parvane::android_v2::incomingJson(in)}, {"event", nullptr}};
    using Kind = parvane::v2::Incoming::Kind;
    if (in.kind == Kind::Message || in.kind == Kind::Stub) out["event"] = parvane::android_v2::messageEvent(in, me, 0);
    return jout(env, out);
}

// Событие v2-сессии (groupL2, l2State) → событие ядра; "" — не из этого набора.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneProtocol_nativeSessionEvent(
        JNIEnv *env, jclass, jstring eventJson, jstring self) {
    const auto ev = json::parse(jstr(env, eventJson), nullptr, false);
    if (!ev.is_object()) return parvane::jniutf::toJava(env, "");
    const auto out = parvane::android_v2::sessionEvent(ev, jstr(env, self), 0);
    return parvane::jniutf::toJava(env, out.is_null() ? std::string() : out.dump());
}

// Своё переключение режима L2 в личном чате → событие ядра (служебное сообщение с id операции).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneProtocol_nativeOwnChatMode(
        JNIEnv *env, jclass, jstring self, jstring peer, jboolean enabled, jstring opId, jlong nowSec) {
    return jout(env, parvane::android_v2::ownChatModeEvent(jstr(env, self), jstr(env, peer), enabled == JNI_TRUE,
                                                           jstr(env, opId), static_cast<std::int64_t>(nowSec)));
}

// v1-содержимое → Content v2 ("" — вид не поддержан v2, идёт по v1).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneProtocol_nativeToV2(
        JNIEnv *env, jclass, jstring v1Json, jstring replyTo) {
    const auto v1 = json::parse(jstr(env, v1Json), nullptr, false);
    if (v1.is_discarded()) return parvane::jniutf::toJava(env, "");
    const auto m = parvane::v2::toV2(v1, jstr(env, replyTo));
    return parvane::jniutf::toJava(env, m ? m->dump() : std::string());
}

// Content v2 → v1-содержимое ("" — не сообщение: мутация/служебное/незнакомое).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneProtocol_nativeFromV2(JNIEnv *env, jclass, jstring v2Json) {
    const auto v2 = json::parse(jstr(env, v2Json), nullptr, false);
    if (v2.is_discarded()) return parvane::jniutf::toJava(env, "");
    const auto m = parvane::v2::fromV2(v2);
    return parvane::jniutf::toJava(env, m ? m->dump() : std::string());
}

// proto3-JSON ↔ base64 байтов сообщения протокола (журнал состояния T098:
// тексты черновиков, содержимое отложенных). "" — не собрано/не разобрано.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneProtocol_nativeEncode(JNIEnv *env, jclass, jstring typeName, jstring jsonText) {
    try {
        const auto v = json::parse(jstr(env, jsonText), nullptr, false);
        if (v.is_discarded()) return parvane::jniutf::toJava(env, "");
        return parvane::jniutf::toJava(env, parvane::v2::toBase64(parvane::v2::encodeMessage(jstr(env, typeName), v)));
    } catch (const std::exception &) {
        return parvane::jniutf::toJava(env, "");
    }
}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneProtocol_nativeDecode(JNIEnv *env, jclass, jstring typeName, jstring b64) {
    try {
        const auto raw = parvane::v2::fromBase64Safe(jstr(env, b64));
        if (!raw) return parvane::jniutf::toJava(env, "");
        return parvane::jniutf::toJava(env, parvane::v2::decodeMessage(jstr(env, typeName), *raw).dump());
    } catch (const std::exception &) {
        return parvane::jniutf::toJava(env, "");
    }
}

} // extern "C"
