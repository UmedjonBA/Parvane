// Сгенерировано gen_bindings (cargo run -p parvane-protocol --bin gen_bindings) из proto/parvane/engine/v1/** — не править руками; проверка — gen_bindings --check (тест bindings_are_fresh).
// Граница движка — proto3-JSON: имена полей схемы, int64 — строка, bytes — base64, enum — имя.
@file:Suppress("unused", "ArrayInDataClass")

package org.parvane.gen

import org.json.JSONArray
import org.json.JSONObject

private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

fun toBase64(b: ByteArray): String {
    val out = StringBuilder()
    var i = 0
    while (i < b.size) {
        val n = ((b[i].toInt() and 0xff) shl 16) or ((if (i + 1 < b.size) b[i + 1].toInt() and 0xff else 0) shl 8) or (if (i + 2 < b.size) b[i + 2].toInt() and 0xff else 0)
        out.append(B64[(n shr 18) and 63]).append(B64[(n shr 12) and 63])
        out.append(if (i + 1 < b.size) B64[(n shr 6) and 63] else '=')
        out.append(if (i + 2 < b.size) B64[n and 63] else '=')
        i += 3
    }
    return out.toString()
}

fun fromBase64(t: String): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    var acc = 0
    var bits = 0
    for (c0 in t) {
        if (c0 == '=' || c0.isWhitespace()) continue
        val c = when (c0) { '-' -> '+'; '_' -> '/'; else -> c0 }
        val v = B64.indexOf(c)
        require(v >= 0) { "base64" }
        acc = (acc shl 6) or v
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out.write((acc shr bits) and 0xff)
        }
    }
    return out.toByteArray()
}

private fun JSONObject.pick(proto: String, camel: String): Any? {
    val v = if (has(proto)) opt(proto) else opt(camel)
    return if (v == null || v == JSONObject.NULL) null else v
}

data class DeviceWrap(
    val wrappedDek: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(wrappedDek.isEmpty())) j.put("wrapped_dek", toBase64(wrappedDek))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): DeviceWrap {
            return DeviceWrap(
                wrappedDek = j.pick("wrapped_dek", "wrappedDek")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class KindFormat(
    val kind: String = "",
    val format: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(kind.isEmpty())) j.put("kind", kind)
        if (!(format == 0L)) j.put("format", format)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): KindFormat {
            return KindFormat(
                kind = j.pick("kind", "kind")?.let { it.toString() } ?: "",
                format = j.pick("format", "format")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class MigrationProgress(
    val fromGeneration: Long = 0L,
    val toGeneration: Long = 0L,
    val point: Long = 0L,
    val errors: List<String> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(fromGeneration == 0L)) j.put("from_generation", fromGeneration)
        if (!(toGeneration == 0L)) j.put("to_generation", toGeneration)
        if (!(point == 0L)) j.put("point", point)
        if (errors.isNotEmpty()) j.put("errors", JSONArray().apply { errors.forEach { put(it) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): MigrationProgress {
            return MigrationProgress(
                fromGeneration = j.pick("from_generation", "fromGeneration")?.let { it.toString().toLong() } ?: 0L,
                toGeneration = j.pick("to_generation", "toGeneration")?.let { it.toString().toLong() } ?: 0L,
                point = j.pick("point", "point")?.let { it.toString().toLong() } ?: 0L,
                errors = (j.pick("errors", "errors") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList()
            )
        }
    }
}

data class PinWrap(
    val salt: ByteArray = ByteArray(0),
    val iterations: Long = 0L,
    val wrappedDek: ByteArray = ByteArray(0),
    val check: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(salt.isEmpty())) j.put("salt", toBase64(salt))
        if (!(iterations == 0L)) j.put("iterations", iterations)
        if (!(wrappedDek.isEmpty())) j.put("wrapped_dek", toBase64(wrappedDek))
        if (!(check.isEmpty())) j.put("check", toBase64(check))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): PinWrap {
            return PinWrap(
                salt = j.pick("salt", "salt")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                iterations = j.pick("iterations", "iterations")?.let { it.toString().toLong() } ?: 0L,
                wrappedDek = j.pick("wrapped_dek", "wrappedDek")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                check = j.pick("check", "check")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class Root(
    val storeId: ByteArray = ByteArray(0),
    val activeGeneration: Long = 0L,
    val pendingGeneration: Long = 0L,
    val wraps: List<Wrap> = emptyList(),
    val kindsMaxFormat: List<KindFormat> = emptyList(),
    val retiringGeneration: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(storeId.isEmpty())) j.put("store_id", toBase64(storeId))
        if (!(activeGeneration == 0L)) j.put("active_generation", activeGeneration)
        if (!(pendingGeneration == 0L)) j.put("pending_generation", pendingGeneration)
        if (wraps.isNotEmpty()) j.put("wraps", JSONArray().apply { wraps.forEach { put(it.toJson()) } })
        if (kindsMaxFormat.isNotEmpty()) j.put("kinds_max_format", JSONArray().apply { kindsMaxFormat.forEach { put(it.toJson()) } })
        if (!(retiringGeneration == 0L)) j.put("retiring_generation", retiringGeneration)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Root {
            return Root(
                storeId = j.pick("store_id", "storeId")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                activeGeneration = j.pick("active_generation", "activeGeneration")?.let { it.toString().toLong() } ?: 0L,
                pendingGeneration = j.pick("pending_generation", "pendingGeneration")?.let { it.toString().toLong() } ?: 0L,
                wraps = (j.pick("wraps", "wraps") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { Wrap.fromJson(it as JSONObject) } } } ?: emptyList(),
                kindsMaxFormat = (j.pick("kinds_max_format", "kindsMaxFormat") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { KindFormat.fromJson(it as JSONObject) } } } ?: emptyList(),
                retiringGeneration = j.pick("retiring_generation", "retiringGeneration")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class StoreBatch(
    val batchId: Long = 0L,
    val puts: List<StorePut> = emptyList(),
    val deletes: List<String> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(batchId == 0L)) j.put("batch_id", batchId.toString())
        if (puts.isNotEmpty()) j.put("puts", JSONArray().apply { puts.forEach { put(it.toJson()) } })
        if (deletes.isNotEmpty()) j.put("deletes", JSONArray().apply { deletes.forEach { put(it) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StoreBatch {
            return StoreBatch(
                batchId = j.pick("batch_id", "batchId")?.let { it.toString().toLong() } ?: 0L,
                puts = (j.pick("puts", "puts") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { StorePut.fromJson(it as JSONObject) } } } ?: emptyList(),
                deletes = (j.pick("deletes", "deletes") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList()
            )
        }
    }
}

data class StoreLoaded(
    val readId: Long = 0L,
    val entries: List<StorePut> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(readId == 0L)) j.put("read_id", readId.toString())
        if (entries.isNotEmpty()) j.put("entries", JSONArray().apply { entries.forEach { put(it.toJson()) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StoreLoaded {
            return StoreLoaded(
                readId = j.pick("read_id", "readId")?.let { it.toString().toLong() } ?: 0L,
                entries = (j.pick("entries", "entries") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { StorePut.fromJson(it as JSONObject) } } } ?: emptyList()
            )
        }
    }
}

data class StorePut(
    val key: String = "",
    val value: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(key.isEmpty())) j.put("key", key)
        if (!(value.isEmpty())) j.put("value", toBase64(value))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StorePut {
            return StorePut(
                key = j.pick("key", "key")?.let { it.toString() } ?: "",
                value = j.pick("value", "value")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class StoreReads(
    val readId: Long = 0L,
    val keys: List<String> = emptyList(),
    val prefix: String = "",
    val after: String = "",
    val limit: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(readId == 0L)) j.put("read_id", readId.toString())
        if (keys.isNotEmpty()) j.put("keys", JSONArray().apply { keys.forEach { put(it) } })
        if (!(prefix.isEmpty())) j.put("prefix", prefix)
        if (!(after.isEmpty())) j.put("after", after)
        if (!(limit == 0L)) j.put("limit", limit)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StoreReads {
            return StoreReads(
                readId = j.pick("read_id", "readId")?.let { it.toString().toLong() } ?: 0L,
                keys = (j.pick("keys", "keys") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList(),
                prefix = j.pick("prefix", "prefix")?.let { it.toString() } ?: "",
                after = j.pick("after", "after")?.let { it.toString() } ?: "",
                limit = j.pick("limit", "limit")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class Stored(
    val format: Long = 0L,
    val kind: String = "",
    val generation: Long = 0L,
    val payload: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(format == 0L)) j.put("format", format)
        if (!(kind.isEmpty())) j.put("kind", kind)
        if (!(generation == 0L)) j.put("generation", generation)
        if (!(payload.isEmpty())) j.put("payload", toBase64(payload))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Stored {
            return Stored(
                format = j.pick("format", "format")?.let { it.toString().toLong() } ?: 0L,
                kind = j.pick("kind", "kind")?.let { it.toString() } ?: "",
                generation = j.pick("generation", "generation")?.let { it.toString().toLong() } ?: 0L,
                payload = j.pick("payload", "payload")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

sealed interface WrapKind {
    data class Device(val value: DeviceWrap) : WrapKind
    data class Pin(val value: PinWrap) : WrapKind
}

data class Wrap(
    val generation: Long = 0L,
    val kind: WrapKind? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(generation == 0L)) j.put("generation", generation)
        when (val o = kind) {
            is WrapKind.Device -> j.put("device", o.value.toJson())
            is WrapKind.Pin -> j.put("pin", o.value.toJson())
            null -> {}
        }
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Wrap {
            var kind: WrapKind? = null
            j.pick("device", "device")?.let { kind = WrapKind.Device(DeviceWrap.fromJson(it as JSONObject)) }
            j.pick("pin", "pin")?.let { kind = WrapKind.Pin(PinWrap.fromJson(it as JSONObject)) }
            return Wrap(
                generation = j.pick("generation", "generation")?.let { it.toString().toLong() } ?: 0L,
                kind = kind
            )
        }
    }
}

