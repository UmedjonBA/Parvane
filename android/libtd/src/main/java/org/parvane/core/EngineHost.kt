package org.parvane.core

import org.json.JSONObject

/**
 * Parvane (spec 035, contracts/engine-api.md): хост модели движка ядра (`parvane::engine::Host`, общий с desktop) —
 * единственная точка вызова `pv_engine_*`. Движок sans-IO: шаг возвращает изменения модели и запросы серверу; хост
 * ядра сам фиксирует пачку хранилища (`store_fs`, fsync) раньше запросов и отдаёт `storeCommitted`. Здесь — только
 * перевод JSON (proto3-JSON на границе). Нативная часть — libparvane_jni.so (устройство) либо хостовая
 * libparvane_protocol_jni.so (JVM-тесты, свойство `parvane.protocol.jni`).
 */
class EngineHost private constructor(private var handle: Long, val opened: JSONObject) : AutoCloseable {
    /** Вызов, меняющий модель (`submit`, `ingest`, `tick`, `vectorInput`, …) → {changes, revisions, requests, put_kinds, batches, open, error?}. */
    fun step(name: String, args: Any = JSONObject()): JSONObject = JSONObject(EngineHostJni.nativeStep(live(), name, args.toString()))
    fun submit(intent: JSONObject): JSONObject = step("submit", intent)
    fun ingest(input: JSONObject): JSONObject = step("ingest", input)
    /** Чтение (`historyPage`, `chatList`, `viewState`, `viewGroup`, `capabilities`, `engineInfo`); ошибка — {"error"}. */
    fun read(name: String, args: Any = JSONObject()): JSONObject = JSONObject(EngineHostJni.nativeRead(live(), name, args.toString()))
    /** Сырой вызов без исполнения итога (тесты). */
    fun raw(name: String, args: Any = JSONObject()): JSONObject = JSONObject(EngineHostJni.nativeRaw(live(), name, args.toString()))
    val revision: Long get() = EngineHostJni.nativeRevision(live())

    @Synchronized override fun close() {
        if (handle != 0L) EngineHostJni.nativeClose(handle)
        handle = 0L
    }

    private fun live(): Long = handle.also { check(it != 0L) { "хост модели закрыт" } }

    companion object {
        /** Открыть движок (`config` — EngineConfig) над хранилищем в каталоге [dir] и выполнить `start`. */
        fun open(config: JSONObject, dir: String): EngineHost {
            ParvaneProtocol.ensureLoaded()
            val r = JSONObject(EngineHostJni.nativeOpen(config.toString(), dir))
            if (r.has("error")) throw IllegalStateException("хост модели: ${r.optString("error")}")
            return EngineHost(r.getString("handle").toLong(), r.optJSONObject("open") ?: JSONObject())
        }
    }
}

/** JNI хоста модели (android/jni/model_jni.cpp). */
internal object EngineHostJni {
    @JvmStatic external fun nativeOpen(config: String, dir: String): String
    @JvmStatic external fun nativeStep(handle: Long, name: String, args: String): String
    @JvmStatic external fun nativeRead(handle: Long, name: String, args: String): String
    @JvmStatic external fun nativeRaw(handle: Long, name: String, args: String): String
    @JvmStatic external fun nativeRevision(handle: Long): Long
    @JvmStatic external fun nativeClose(handle: Long)
}
