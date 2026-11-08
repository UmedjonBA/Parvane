package org.drinkless.tdlib

import org.json.JSONArray

/**
 * Волна голосового сообщения. X (как TDLib) хранит её упакованной: отсчёты по 5 бит подряд, младшие биты первыми
 * (формат Telegram). На проводе (`Media.waveform`, web `contentMap.ts`, ядро `mediaToV2`) — один байт на отсчёт
 * 0..31. Здесь — перевод между ними.
 */
object Waveform {
    private const val BITS = 5
    private const val MAX = 31
    /** Предел отсчётов на проводе (`Media.waveform` ≤ 256 байт). */
    const val WIRE_MAX = 256

    /** Упакованная волна X → отсчёты 0..31. */
    fun unpack(packed: ByteArray?): IntArray {
        if (packed == null || packed.isEmpty()) return IntArray(0)
        val count = packed.size * 8 / BITS
        return IntArray(count) { i ->
            val bit = i * BITS
            val byte = bit / 8
            val lo = packed[byte].toInt() and 0xff
            val hi = if (byte + 1 < packed.size) packed[byte + 1].toInt() and 0xff else 0
            ((lo or (hi shl 8)) ushr (bit % 8)) and MAX
        }
    }

    /** Отсчёты 0..31 → упакованная волна X. */
    fun pack(samples: IntArray): ByteArray {
        if (samples.isEmpty()) return ByteArray(0)
        val out = ByteArray((samples.size * BITS + 7) / 8)
        samples.forEachIndexed { i, s ->
            val v = s.coerceIn(0, MAX)
            val bit = i * BITS
            val byte = bit / 8
            val shifted = v shl (bit % 8)
            out[byte] = (out[byte].toInt() or (shifted and 0xff)).toByte()
            if (byte + 1 < out.size) out[byte + 1] = (out[byte + 1].toInt() or (shifted ushr 8)).toByte()
        }
        return out
    }

    /** Волна X → поле `waveform` содержимого провода; null — волны нет. */
    fun toWire(packed: ByteArray?): JSONArray? {
        val s = unpack(packed)
        if (s.isEmpty()) return null
        val step = if (s.size > WIRE_MAX) s.size.toDouble() / WIRE_MAX else 1.0
        val n = minOf(s.size, WIRE_MAX)
        return JSONArray().also { a -> for (i in 0 until n) a.put(s[(i * step).toInt()]) }
    }

    /** Поле `waveform` провода (web, desktop, ядро) → волна X; пустая — X нарисует ровную. */
    fun fromWire(arr: JSONArray?): ByteArray {
        if (arr == null || arr.length() == 0) return ByteArray(0)
        return pack(IntArray(minOf(arr.length(), WIRE_MAX)) { arr.optInt(it) })
    }
}
