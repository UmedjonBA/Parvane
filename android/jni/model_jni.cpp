// Parvane Android (spec 035 T130): JNI хоста модели движка — org.parvane.core.EngineHostJni над хостом ядра
// `parvane::engine::Host` (единственная точка `pv_engine_*`, общий с desktop) и файловым хранилищем `store_fs`:
// open/step/read/raw/close. Порядок итога (чтения → пачка с fsync → запросы → storeCommitted) соблюдает хост ядра,
// JNI только переводит JSON. Векторы `model/*` гоняет ModelVectorsTest.kt на хосте; на устройстве — то же ядро.
// Входит в libparvane_jni.so на устройстве и в хостовую libparvane_protocol_jni.so (android/jni/host).
#include <jni.h>

#include <parvane/engine_host.h>

#include "jni_utf.h"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <memory>
#include <string>

using json = nlohmann::json;

namespace {

std::string jstr(JNIEnv *env, jstring s) { return parvane::jniutf::fromJava(env, s); }
jstring jout(JNIEnv *env, const json &j) { return parvane::jniutf::toJava(env, j.dump()); }

json parseArgs(JNIEnv *env, jstring s) {
    auto j = json::parse(jstr(env, s), nullptr, false);
    return j.is_discarded() ? json::object() : j;
}

parvane::engine::Host *hostOf(jlong h) { return reinterpret_cast<parvane::engine::Host *>(h); }

json stepJson(const parvane::engine::Step &st) {
    json out{{"changes", st.changes},     {"revisions", st.revisions}, {"requests", st.requests},
             {"put_kinds", st.putKinds}, {"batches", st.batches},     {"open", st.open}};
    if (!st.ok()) out["error"] = st.error;
    return out;
}

} // namespace

extern "C" {

// → {"handle": "<n>", "open": OpenResult} либо {"error": "…"}
JNIEXPORT jstring JNICALL Java_org_parvane_core_EngineHostJni_nativeOpen(JNIEnv *env, jclass, jstring config, jstring dir) {
    std::string err;
    parvane::engine::Step opened;
    auto host = parvane::engine::Host::open(parseArgs(env, config), jstr(env, dir), &err,
                                            parvane::store_fs::posixFs(), &opened);
    if (!host) return jout(env, json{{"error", err.empty() ? std::string("open") : err}});
    const auto handle = reinterpret_cast<std::intptr_t>(host.release());
    return jout(env, json{{"handle", std::to_string(handle)}, {"open", opened.open}});
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_EngineHostJni_nativeStep(JNIEnv *env, jclass, jlong h, jstring name, jstring args) {
    if (!h) return jout(env, json{{"error", "closed"}});
    return jout(env, stepJson(hostOf(h)->step(jstr(env, name), parseArgs(env, args))));
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_EngineHostJni_nativeRead(JNIEnv *env, jclass, jlong h, jstring name, jstring args) {
    if (!h) return jout(env, json{{"error", "closed"}});
    return jout(env, hostOf(h)->read(jstr(env, name), parseArgs(env, args)));
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_EngineHostJni_nativeRaw(JNIEnv *env, jclass, jlong h, jstring name, jstring args) {
    if (!h) return jout(env, json{{"error", "closed"}});
    return jout(env, hostOf(h)->raw(jstr(env, name), parseArgs(env, args)));
}

JNIEXPORT jlong JNICALL Java_org_parvane_core_EngineHostJni_nativeRevision(JNIEnv *, jclass, jlong h) {
    return h ? static_cast<jlong>(hostOf(h)->revision()) : 0;
}

JNIEXPORT void JNICALL Java_org_parvane_core_EngineHostJni_nativeClose(JNIEnv *, jclass, jlong h) {
    delete hostOf(h);
}
} // extern "C"
