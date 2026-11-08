// Parvane Android (spec 035 T131): проба очереди событий ядра с настоящей JVM — та же jni/event_queue.h, что у
// событий ядра в jni_main.cpp: поток очереди присоединяется AttachCurrentThread, пачки уходят в Kotlin статическим
// вызовом ParvaneProtocol.onProbeBatch (тест EventQueueJniTest.kt). Входит в libparvane_jni.so и в хостовую
// libparvane_protocol_jni.so.
#include <jni.h>

#include "event_queue.h"
#include "jni_utf.h"

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

using json = nlohmann::json;

namespace {
jstring jout(JNIEnv *env, const json &j) { return parvane::jniutf::toJava(env, j.dump()); }
thread_local JNIEnv *t_queueEnv = nullptr;
} // namespace

extern "C" {

// `count` событий с потока ядра (не присоединённого к JVM) → очередь с потолком `maxEvents` → пачки в
// ParvaneProtocol.onProbeBatch(String) с потока очереди. Ответ — счётчики очереди.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneProtocol_nativeEventQueueProbe(
        JNIEnv *env, jclass cls, jint count, jint maxEvents, jint slowMs) {
    JavaVM *vm = nullptr;
    if (env->GetJavaVM(&vm) != JNI_OK || !vm) return jout(env, json{{"error", "vm"}});
    const auto klass = static_cast<jclass>(env->NewGlobalRef(cls));
    const jmethodID sink = env->GetStaticMethodID(klass, "onProbeBatch", "(Ljava/lang/String;)V");
    if (!sink) {
        env->ExceptionClear();
        env->DeleteGlobalRef(klass);
        return jout(env, json{{"error", "onProbeBatch"}});
    }
    std::atomic<int> attaches{0}, detaches{0};
    pvjni::EventQueueLimits lim;
    lim.maxEvents = static_cast<std::size_t>(maxEvents > 0 ? maxEvents : 16);
    pvjni::EventQueueStats st;
    {
        pvjni::EventQueue q(
            lim,
            [&](const std::vector<std::string> &batch) {
                JNIEnv *e = t_queueEnv;
                if (!e) return;
                std::string s = "[";
                for (std::size_t i = 0; i < batch.size(); ++i) {
                    if (i) s += ',';
                    s += batch[i];
                }
                s += ']';
                jstring js = parvane::jniutf::toJava(e, s);
                e->CallStaticVoidMethod(klass, sink, js);
                e->DeleteLocalRef(js);
                if (e->ExceptionCheck()) e->ExceptionClear();
                if (slowMs > 0) std::this_thread::sleep_for(std::chrono::milliseconds(slowMs));
            },
            [&] {
                JNIEnv *e = nullptr;
#ifdef __ANDROID__
                if (vm->AttachCurrentThread(&e, nullptr) != JNI_OK) return false; // NDK: JNIEnv **
#else
                if (vm->AttachCurrentThread(reinterpret_cast<void **>(&e), nullptr) != JNI_OK) return false; // JDK: void **
#endif
                t_queueEnv = e;
                attaches++;
                return true;
            },
            [&] {
                t_queueEnv = nullptr;
                vm->DetachCurrentThread();
                detaches++;
            });
        std::thread producer([&] {
            for (int i = 0; i < count; ++i) q.push("{\"type\":\"probe\",\"n\":" + std::to_string(i) + "}");
        });
        producer.join();
        q.waitIdle(60000);
        st = q.stats();
    }
    env->DeleteGlobalRef(klass);
    return jout(env, json{{"attach", attaches.load()},  {"detach", detaches.load()}, {"batches", st.batches},
                          {"delivered", st.delivered},  {"waits", st.waits},         {"overflow", st.overflow},
                          {"max_queued", st.maxQueued}, {"max_events", lim.maxEvents}});
}

} // extern "C"
