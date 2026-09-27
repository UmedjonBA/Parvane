package org.drinkless.tdlib

/**
 * spec 005: идентификаторы паков и кастом-эмодзи — та же формула, что в
 * parvane-core (`pack_archive.h`), web (`stickerPacks.ts`) и desktop
 * (`docIdFromFileId`): FNV-1a-64 со смещением провода 1469598103934665603
 * (стандартное без последней цифры — исторический формат, conformance EMOJI-1),
 * знаковый int64. Чистый JVM-код, дублирует C++ для тестов и для работы без ядра.
 */
object EmojiDocId {
    const val OFFSET_BASIS: Long = 1469598103934665603L
    const val PRIME: Long = 1099511628211L

    fun fnv1a64Signed(utf8: String): Long {
        var h = OFFSET_BASIS
        for (b in utf8.toByteArray(Charsets.UTF_8)) {
            h = h xor (b.toLong() and 0xFF)
            h *= PRIME
        }
        return h
    }

    /** docId кастом-эмодзи: FNV("pvemoji:<rawName>|<file>") — EMOJI-1. */
    fun emojiDocId(rawName: String, file: String): Long = fnv1a64Signed("pvemoji:$rawName|$file")
    /** id набора стикеров: FNV("pack:<sanitizedName>") — как desktop. */
    fun packSetId(sanitizedName: String): Long = fnv1a64Signed("pack:$sanitizedName")
    /** id набора эмодзи: FNV("pvemoji-set:<rawName>") — как desktop. */
    fun emojiSetId(rawName: String): Long = fnv1a64Signed("pvemoji-set:$rawName")

    /** Имя пака как каталог: буквы/цифры/пробел/-/_, trim, ≤32 code point, fallback "Pack". */
    fun sanitizeName(name: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < name.length) {
            val cp = name.codePointAt(i)
            if (Character.isLetterOrDigit(cp) || cp == ' '.code || cp == '-'.code || cp == '_'.code) sb.appendCodePoint(cp)
            i += Character.charCount(cp)
        }
        var s = sb.toString().trim()
        if (s.codePointCount(0, s.length) > 32) s = s.substring(0, s.offsetByCodePoints(0, 32)).trimEnd()
        return s.ifEmpty { "Pack" }
    }

    private val ALLOWED = setOf("webp", "png", "tgs", "webm")
    fun isAllowedName(name: String): Boolean = name.substringAfterLast('.', "").lowercase() in ALLOWED
    fun mimeForName(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "webp" -> "image/webp"; "png" -> "image/png"; "tgs" -> "application/x-tgsticker"; "webm" -> "video/webm"; else -> ""
    }

    /** Alt-эмодзи из имени файла пака `NN-<hex code point>.<ext>` (как web/desktop); иначе fallback. */
    fun altEmojiForFileName(name: String, fallback: String = "🙂"): String {
        val dash = name.indexOf('-'); val dot = name.lastIndexOf('.')
        if (dash < 0 || dot <= dash + 1) return fallback
        val hex = name.substring(dash + 1, dot)
        if (hex.isEmpty() || hex.length > 6 || !hex.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return fallback
        val cp = hex.toInt(16)
        if (cp == 0 || cp > 0x10FFFF) return fallback
        return String(Character.toChars(cp))
    }

    /** Имя файла встроенного пака по индексу и эмодзи (web `customEmojiFileName`). */
    fun builtinFileName(index: Int, emoji: String): String =
        index.toString().padStart(2, '0') + "-" + emoji.codePointAt(0).toString(16) + ".png"
}
