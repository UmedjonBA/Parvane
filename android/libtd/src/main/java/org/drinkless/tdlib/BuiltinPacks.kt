package org.drinkless.tdlib

import java.io.File

/**
 * spec 005: встроенные паки — как на web (`stickers.ts`): эмодзи-пак
 * `ParvaneEmoji` (12 эмодзи, 128 px, PNG) и набор стикеров `ParvaneStickers`
 * (12 эмодзи-стикеров, 512 px, PNG). Web рисует их canvas'ом; здесь — Android
 * Canvas при первом старте, файлы в `packs/builtin/<name>/NN-<hex>.png`. Имена
 * файлов и сырые имена паков совпадают с web, поэтому docId кастом-эмодзи
 * (EMOJI-1) одинаковы на всех клиентах. В JVM-тестах рендер недоступен —
 * [render] возвращает false, индекс не трогается.
 */
object BuiltinPacks {
    const val EMOJI_PACK_NAME = "ParvaneEmoji"
    const val STICKER_PACK_NAME = "ParvaneStickers"
    const val EMOJI_SIZE = 128
    const val STICKER_SIZE = 512
    // web stickers.ts: EMOJI_PACK (12) и EMOJIS стикеров (12)
    val EMOJI_PACK = listOf("🦋", "✨", "🌙", "⭐", "🍀", "🌈", "💎", "🐱", "🍕", "🎈", "🌸", "⚡")
    val STICKER_EMOJIS = listOf("😀", "😂", "😍", "👍", "🔥", "🎉", "❤️", "😎", "🙈", "🤔", "👋", "🚀")

    fun fileNames(emojis: List<String>): List<String> = emojis.mapIndexed { i, e -> EmojiDocId.builtinFileName(i, e) }

    /** Нарисовать оба пака в [root]/builtin/<name>/ (если ещё нет) и зарегистрировать в [index]. */
    fun ensure(root: File, index: PackIndex): Boolean {
        var ok = true
        ok = ok and ensureOne(File(root, "builtin/$EMOJI_PACK_NAME"), EMOJI_PACK, EMOJI_SIZE, EMOJI_PACK_NAME, true, index)
        ok = ok and ensureOne(File(root, "builtin/$STICKER_PACK_NAME"), STICKER_EMOJIS, STICKER_SIZE, STICKER_PACK_NAME, false, index)
        return ok
    }

    private fun ensureOne(dir: File, emojis: List<String>, size: Int, name: String, isEmoji: Boolean, index: PackIndex): Boolean {
        val names = fileNames(emojis)
        val missing = names.filterIndexed { i, n -> !File(dir, n).exists() }
        if (missing.isNotEmpty()) {
            dir.mkdirs()
            emojis.forEachIndexed { i, e -> val f = File(dir, names[i]); if (!f.exists() && !render(e, size, f)) return false }
        }
        index.addBuiltin(name, isEmoji, dir.absolutePath, names, size)
        return true
    }

    /** PNG с эмодзи по центру прозрачного квадрата; false — рендер недоступен (JVM). */
    fun render(emoji: String, size: Int, out: File): Boolean = try {
        val bitmap = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888) ?: return false
        val canvas = android.graphics.Canvas(bitmap)
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            textSize = size * 0.78f
            textAlign = android.graphics.Paint.Align.CENTER
        }
        val y = size / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(emoji, size / 2f, y, paint)
        out.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        out.length() > 0
    } catch (e: Throwable) { false }
}
