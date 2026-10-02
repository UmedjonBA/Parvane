package org.parvane.core

import org.json.JSONObject

/**
 * Parvane: движок протокола v2 без сети (spec 007) — общие векторы conformance
 * через C ABI (`pv_run_conformance_vectors`) и отображение событий v2 в события
 * ядра (тот же код `jni/v2_bridge.h`, что перекладывает v2-входящие на
 * телефоне). На устройстве нативная часть живёт в libparvane_jni.so; в
 * JVM-тестах — хостовая libparvane_protocol_jni.so (`android/build-host-jni.sh`),
 * путь которой передаётся системным свойством `parvane.protocol.jni`.
 */
object ParvaneProtocol {
    @Volatile private var loaded = false

    @Synchronized
    private fun ensureLoaded() {
        if (loaded) return
        val host = System.getProperty("parvane.protocol.jni")
        if (!host.isNullOrEmpty()) System.load(host) else System.loadLibrary("parvane_jni")
        loaded = true
    }

    /** {"version": "…", "major": 2} */
    fun engine(): JSONObject { ensureLoaded(); return JSONObject(nativeEngineVersion()) }

    /** Прогон набора векторов: число сошедшихся случаев; расхождение — исключение. */
    fun runConformanceVectors(suite: String, vectorsJson: String): Long {
        ensureLoaded()
        val r = JSONObject(nativeRunConformanceVectors(suite, vectorsJson))
        if (r.has("error")) throw IllegalStateException("$suite: ${r.optString("error")}")
        return r.optLong("cases", -1)
    }

    /** Событие движка → {"incoming": {...}, "event": событие ядра | null}. */
    fun interpretDirect(eventJson: String, self: String): JSONObject {
        ensureLoaded()
        return JSONObject(nativeInterpretDirect(eventJson, self))
    }

    /** Событие v2-сессии (groupL2, l2State) → событие ядра; null — не из этого набора. */
    fun sessionEvent(eventJson: String, self: String): JSONObject? {
        ensureLoaded()
        return nativeSessionEvent(eventJson, self).takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
    }

    /** Своё переключение режима L2 в личном чате → событие ядра (служебное сообщение с id операции). */
    fun ownChatMode(self: String, peer: String, enabled: Boolean, opId: String, nowSec: Long): JSONObject {
        ensureLoaded()
        return JSONObject(nativeOwnChatMode(self, peer, enabled, opId, nowSec))
    }

    /** v1-содержимое → Content v2 (null — вид не поддержан v2, идёт по v1). */
    fun toV2(v1Json: String, replyTo: String = ""): JSONObject? {
        ensureLoaded()
        return nativeToV2(v1Json, replyTo).takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
    }

    /** Content v2 → v1-содержимое (null — не сообщение). */
    fun fromV2(v2Json: String): JSONObject? {
        ensureLoaded()
        return nativeFromV2(v2Json).takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
    }

    /** proto3-JSON → base64 байтов сообщения протокола по полному имени типа ("" — не собрано). */
    fun encode(type: String, json: String): String { ensureLoaded(); return nativeEncode(type, json) }

    /** base64 байтов → proto3-JSON ("" — не разобрано). */
    fun decode(type: String, b64: String): String { ensureLoaded(); return nativeDecode(type, b64) }

    /** Кодек журнала личного состояния (T098) на движке. */
    val stateCodec = object : org.drinkless.tdlib.StateJournal.Codec {
        override fun encode(type: String, json: String) = ParvaneProtocol.encode(type, json)
        override fun decode(type: String, b64: String) = ParvaneProtocol.decode(type, b64)
        override fun toV2(v1Json: String, replyTo: String) = ParvaneProtocol.toV2(v1Json, replyTo)?.toString() ?: ""
        override fun fromV2(v2Json: String) = ParvaneProtocol.fromV2(v2Json)?.toString() ?: ""
    }

    @JvmStatic private external fun nativeSessionEvent(eventJson: String, self: String): String
    @JvmStatic private external fun nativeOwnChatMode(self: String, peer: String, enabled: Boolean, opId: String, nowSec: Long): String
    @JvmStatic private external fun nativeFromV2(v2Json: String): String
    @JvmStatic private external fun nativeEncode(type: String, json: String): String
    @JvmStatic private external fun nativeDecode(type: String, b64: String): String
    @JvmStatic private external fun nativeEngineVersion(): String
    @JvmStatic private external fun nativeRunConformanceVectors(suite: String, vectorsJson: String): String
    @JvmStatic private external fun nativeInterpretDirect(eventJson: String, self: String): String
    @JvmStatic private external fun nativeToV2(v1Json: String, replyTo: String): String
}
