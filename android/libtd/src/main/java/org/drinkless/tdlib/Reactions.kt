package org.drinkless.tdlib

import java.io.File

/**
 * Какие реакции бывают (A4, ревью 7 ноя 2026). Реакция на проводе — просто эмодзи (`Content.reaction.emoji`), поэтому
 * любой эмодзи совместим с web и desktop; набор выбора — тот же, что у web (`provider.ts BUILTIN_REACTIONS`, первые
 * семь в том же порядке), плюс бесплатные реакции Telegram, которые desktop показывает своим списком.
 * X рисует реакцию по `EmojiReaction` (стикеры значка и анимаций): у Parvane анимаций Telegram нет — значок рисуется
 * из самого эмодзи (PNG 128 px, как встроенные паки, [BuiltinPacks.render]) и служит всеми кадрами реакции.
 */
object Reactions {
    /** Порядок выбора в меню сообщения и на экране «Быстрая реакция». */
    val ACTIVE: Array<String> = arrayOf(
        "👍", "❤️", "🔥", "😂", "👏", "🎉", "🤔",
        "👎", "😁", "😢", "😮", "😱", "🙏", "👌", "🥰", "🤩", "💯", "🤝", "😍", "🤣",
    )
    const val ICON_SIZE = 128

    fun isActive(emoji: String?): Boolean = emoji != null && emoji in ACTIVE

    /** Набор для `GetMessageAvailableReactions`: только эмодзи, без Premium и кастом-эмодзи (у Parvane их в реакциях нет). */
    fun available(): TdApi.AvailableReactions = TdApi.AvailableReactions(
        ACTIVE.map { TdApi.AvailableReaction(TdApi.ReactionTypeEmoji(it), false) }.toTypedArray(),
        arrayOf(), arrayOf(), false, false, null)

    /** Имя файла значка: по кодовым точкам (как имена файлов встроенных паков), без самого эмодзи в имени. */
    fun iconName(emoji: String): String =
        "r-" + emoji.codePoints().toArray().joinToString("-") { Integer.toHexString(it) } + ".png"

    /** Файл значка в [dir]; нет — нарисовать ([render], в JVM-тестах — подставной). null — не нарисовать. */
    fun iconFile(dir: File, emoji: String, render: (String, Int, File) -> Boolean = BuiltinPacks::render): File? {
        if (emoji.isEmpty() || emoji.length > 16) return null
        val f = File(dir, iconName(emoji))
        if (f.isFile && f.length() > 0) return f
        dir.mkdirs()
        return if (render(emoji, ICON_SIZE, f) && f.isFile && f.length() > 0) f else null
    }

    /** EmojiReaction для X: один и тот же статичный значок — и значок, и все кадры (центр/вокруг — по умолчанию X). */
    fun emojiReaction(emoji: String, icon: TdApi.File): TdApi.EmojiReaction {
        val sticker = TdApi.Sticker(icon.id.toLong(), 0L, ICON_SIZE, ICON_SIZE, emoji, TdApi.StickerFormatWebp(),
            TdApi.StickerFullTypeRegular(null), TdApi.Thumbnail(TdApi.ThumbnailFormatPng(), ICON_SIZE, ICON_SIZE, icon), icon)
        return TdApi.EmojiReaction(emoji, emoji, isActive(emoji), sticker, sticker, sticker, sticker, sticker, null, null)
    }
}
