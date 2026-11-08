package org.drinkless.tdlib

import org.json.JSONObject

/**
 * MEDIA-2 и QUOTE-1 (этап 4 ревью 7 ноя 2026, контракт web `content.proto`): спойлер медиа (`Media.spoiler`), подпись
 * над медиа (`Content.invert_media`), альбом (`Media.album_id` — 16 случайных байт, одно значение у всех элементов) и
 * цитата в ответе (`Content.reply_quote`). Ядро (`v2_content.cpp`) мапит v1-ключи `spoiler`, `invert_media`,
 * `album_id` (base64), `reply_quote` {text, entities, offset}. Чистый JVM-класс.
 */
object MediaFlags {
    /** Не больше элементов в одной группе альбома (Telegram, MEDIA-2). */
    const val ALBUM_MAX = 10
    private val SPOILER_KINDS = setOf("photo", "video", "gif")

    /** Флаги X из InputMessageContent → v1-содержимое (спойлер — только фото/видео/GIF). */
    fun applyInput(content: JSONObject, c: TdApi.InputMessageContent?) {
        val (above, spoiler) = when (c) {
            is TdApi.InputMessagePhoto -> c.showCaptionAboveMedia to c.hasSpoiler
            is TdApi.InputMessageVideo -> c.showCaptionAboveMedia to c.hasSpoiler
            is TdApi.InputMessageAnimation -> c.showCaptionAboveMedia to c.hasSpoiler
            is TdApi.InputMessageText -> (c.linkPreviewOptions?.showAboveText == true) to false
            else -> false to false
        }
        // подпись над медиа — только при непустой подписи (MEDIA-2 п. 2); у текста — карточка ссылки над текстом
        val hasText = content.optString(if (c is TdApi.InputMessageText) "text" else "caption").isNotEmpty()
        if (above && hasText) content.put("invert_media", true)
        if (spoiler && content.optString("kind") in SPOILER_KINDS) content.put("spoiler", true)
        // Сущности подписи медиа (ядро кладёт их в Media.caption_entities); у текста — свои, уже в содержимом
        val caption = when (c) {
            is TdApi.InputMessagePhoto -> c.caption
            is TdApi.InputMessageVideo -> c.caption
            is TdApi.InputMessageAnimation -> c.caption
            is TdApi.InputMessageDocument -> c.caption
            is TdApi.InputMessageVoiceNote -> c.caption
            else -> null
        }
        if (caption != null && !content.has("entities")) Entities.toWire(caption.entities)?.let { content.put("entities", it) }
    }

    fun spoiler(c: JSONObject): Boolean = c.optBoolean("spoiler", false) && c.optString("kind") in SPOILER_KINDS
    fun invert(c: JSONObject): Boolean = c.optBoolean("invert_media", false)

    /** Случайный album_id (base64 16 байт) — один на весь альбом. */
    fun newAlbumId(random: java.util.Random = java.security.SecureRandom()): String =
        java.util.Base64.getEncoder().encodeToString(ByteArray(16).also { random.nextBytes(it) })

    /** album_id содержимого, если он корректный (16 байт), иначе "". */
    fun albumOf(c: JSONObject?): String {
        val a = c?.optString("album_id").orEmpty()
        if (a.isEmpty()) return ""
        return try { if (java.util.Base64.getDecoder().decode(a).size == 16) a else "" } catch (e: IllegalArgumentException) { "" }
    }

    /**
     * `media_album_id` нового сообщения: продолжает группу предыдущего сообщения чата, если у того тот же автор и тот же
     * album_id и в группе меньше [ALBUM_MAX]; иначе — новая группа (не 0). Без album_id — 0.
     * [prevAlbum]/[prevSender]/[prevMediaAlbumId] — предыдущее сообщение чата, [groupSize] — сколько в его группе.
     */
    fun mediaAlbumId(album: String, sender: Long, uuid: String, prevAlbum: String, prevSender: Long, prevMediaAlbumId: Long, groupSize: Int): Long {
        if (album.isEmpty()) return 0L
        if (prevMediaAlbumId != 0L && prevAlbum == album && prevSender == sender && groupSize < ALBUM_MAX) return prevMediaAlbumId
        val h = (album + "/" + uuid).fold(1125899906842597L) { acc, ch -> 31 * acc + ch.code }
        return (h and Long.MAX_VALUE).takeIf { it != 0L } ?: 1L
    }

    /** Цитата ответа X → v1 `reply_quote` (null — нет цитаты). */
    fun quoteOf(replyTo: TdApi.InputMessageReplyTo?): JSONObject? {
        val q = (replyTo as? TdApi.InputMessageReplyToMessage)?.quote ?: return null
        val text = q.text?.text.orEmpty()
        if (text.isEmpty()) return null
        val o = JSONObject().put("text", text)
        Entities.toWire(q.text?.entities)?.let { o.put("entities", it) }
        if (q.position > 0) o.put("offset", q.position)
        return o
    }

    /** v1 `reply_quote` → TextQuote X (выделенная вручную цитата). */
    fun textQuote(c: JSONObject?): TdApi.TextQuote? {
        val q = c?.optJSONObject("reply_quote") ?: return null
        val text = q.optString("text")
        if (text.isEmpty()) return null
        return TdApi.TextQuote(TdApi.FormattedText(text, Entities.fromWire(q.optJSONArray("entities"), text)), q.optInt("offset", 0), true)
    }
}
