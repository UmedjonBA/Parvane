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
    internal fun ensureLoaded() {
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

    /** spec 035 T136 (ENGINE-1): содержимое формата экспорта → Content (proto3-JSON) — разбор движка
     *  (`contentOfWire`); null — не собрано. [replyTo] — uuid ответа. */
    fun contentOfWire(wireJson: String, replyTo: String = ""): JSONObject? {
        ensureLoaded()
        val args = JSONObject().put("wire", wireJson)
        if (replyTo.isNotEmpty()) args.put("replyTo", replyTo)
        return nativeEngineStatic("contentOfWire", args.toString()).takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
    }

    /**
     * GROUP-2 (spec 035 T136, ENGINE-1): скрыл бы приёмный фильтр содержимое [wire] автора с ролью [role] при правах
     * группы по умолчанию [perms] — решает движок (`GroupFacts::hidden_for_role`), своей формулы у шва нет. Поле прав,
     * которого нет в [perms], — «разрешено» (как сведения группы без полей прав по умолчанию); [perms] null — не скрыто.
     */
    fun groupContentHidden(perms: JSONObject?, role: String, wire: JSONObject): Boolean {
        if (perms == null) return false
        ensureLoaded()
        val full = JSONObject()
        for (k in listOf("send_messages", "send_media", "send_stickers_gifs", "send_polls", "embed_links", "invite_users", "pin_messages", "change_info"))
            full.put(k, perms.optBoolean(k, true))
        val out = nativeEngineStatic("groupContentHidden", JSONObject().put("perms", full).put("role", role).put("wire", wire).toString())
        return out.trim() == "true"
    }

    /** Что содержимое значит (`contentView` движка: class, wire, replyTo, mutation); null — не разобрано. */
    fun contentView(contentJson: String): JSONObject? {
        ensureLoaded()
        return nativeEngineStatic("contentView", JSONObject().put("content", contentJson).toString())
            .takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
    }

    /** proto3-JSON → base64 байтов сообщения протокола по полному имени типа ("" — не собрано). */
    fun encode(type: String, json: String): String { ensureLoaded(); return nativeEncode(type, json) }

    /** base64 байтов → proto3-JSON ("" — не разобрано). */
    fun decode(type: String, b64: String): String { ensureLoaded(); return nativeDecode(type, b64) }

    /** PACK-2: файлы набора [{"name","data"(base64)}] → {"hash", "matches"} (тот же код ядра, что nativePackFetch). */
    fun packHash(filesJson: String): JSONObject { ensureLoaded(); return JSONObject(nativePackHash(filesJson)) }

    /** Кодек журнала личного состояния (T098) на движке. */
    val stateCodec = object : org.drinkless.tdlib.StateJournal.Codec {
        override fun encode(type: String, json: String) = ParvaneProtocol.encode(type, json)
        override fun decode(type: String, b64: String) = ParvaneProtocol.decode(type, b64)
        override fun contentOfWire(wireJson: String, replyTo: String) = ParvaneProtocol.contentOfWire(wireJson, replyTo)?.toString() ?: ""
        override fun wireOf(contentJson: String) = ParvaneProtocol.contentView(contentJson)?.optJSONObject("wire")?.toString() ?: ""
    }

    // ── проба очереди событий ядра (spec 035 T131): та же jni/event_queue.h, что у событий ядра на устройстве ──
    @Volatile private var probeSink: ((String) -> Unit)? = null

    /** Пачка пробы — JSON-массив событий по порядку (поток очереди JNI). */
    @JvmStatic
    fun onProbeBatch(batch: String) { probeSink?.invoke(batch) }

    /**
     * [count] событий с потока ядра, не присоединённого к JVM → очередь с потолком [maxEvents] → пачки в [sink].
     * Ответ — счётчики очереди: attach/detach (присоединений потока очереди), batches, waits (паузы производителя),
     * overflow (потолок обойдён по таймауту), max_queued.
     */
    @Synchronized
    fun eventQueueProbe(count: Int, maxEvents: Int, slowMs: Int, sink: (String) -> Unit): JSONObject {
        ensureLoaded()
        probeSink = sink
        try { return JSONObject(nativeEventQueueProbe(count, maxEvents, slowMs)) } finally { probeSink = null }
    }

    @JvmStatic private external fun nativeEventQueueProbe(count: Int, maxEvents: Int, slowMs: Int): String
    @JvmStatic private external fun nativeSessionEvent(eventJson: String, self: String): String
    @JvmStatic private external fun nativeOwnChatMode(self: String, peer: String, enabled: Boolean, opId: String, nowSec: Long): String
    @JvmStatic private external fun nativeEncode(type: String, json: String): String
    @JvmStatic private external fun nativeDecode(type: String, b64: String): String
    @JvmStatic private external fun nativeEngineVersion(): String
    @JvmStatic private external fun nativePackHash(filesJson: String): String
    @JvmStatic private external fun nativeRunConformanceVectors(suite: String, vectorsJson: String): String
    @JvmStatic private external fun nativeInterpretDirect(eventJson: String, self: String): String
    @JvmStatic private external fun nativeEngineStatic(name: String, argsJson: String): String
}
