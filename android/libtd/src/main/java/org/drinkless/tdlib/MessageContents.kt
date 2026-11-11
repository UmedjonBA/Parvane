package org.drinkless.tdlib

import org.json.JSONObject

/**
 * spec 035 T136 (ENGINE-1): перевод готового содержимого сообщения (формат экспорта `MessageView.wire` движка — его же
 * отдаёт событие ядра) в TdApi-контент X. Виды разбирает движок (`content_view`/`content_to_wire`); шов только
 * раскладывает то, что X умеет показать своим экраном, остальное — текстом `text` (CONTENT-1) либо заглушкой X.
 */
// optString отдаёт строку "null" для JSON null — в списке чатов светилось «null» (10 сен 2026)
// Подпись медиа с сущностями (Media.caption_entities ядро кладёт в `entities` содержимого)
private fun caption(c: JSONObject) = (if (c.isNull("caption")) "" else c.optString("caption"))
    .let { t -> TdApi.FormattedText(t, if (t.isEmpty()) arrayOf() else Entities.fromWire(c.optJSONArray("entities"), t)) }


/** TdApi-контент по нашему JSON (kind: text | photo | video | file | voice | video_note | sticker | gif | poll | location; иное → MessageUnsupported).
 *  [from]/[out] — автор и «своё»: нужны служебному сообщению о смене режима L2 (kind=chat_mode). */
fun ParvaneStore.contentFrom(c: JSONObject, uuid: String = "", from: String = "", out: Boolean = false): TdApi.MessageContent {
    val kind = c.optString("kind")
    val fid = c.optString("file_id")
    val size = c.optLong("size_bytes")
    val mime = c.optString("mime")
    val local = c.optString("local_path")
    val file = { if (fid.isEmpty()) null else fileFor(fid, c.optString("file_key"), c.optString("file_nonce"), size, mime, local) }
    return when (kind) {
        "photo" -> {
            val w = c.optInt("width", 800); val h = c.optInt("height", 600)
            val f = file() ?: return textContent(c)
            TdApi.MessagePhoto(TdApi.Photo(false, null, arrayOf(TdApi.PhotoSize("y", f, w, h, IntArray(0)))), null, caption(c), MediaFlags.invert(c), MediaFlags.spoiler(c), false)
        }
        "video" -> {
            val f = file() ?: return textContent(c)
            TdApi.MessageVideo(TdApi.Video(c.optInt("duration_secs"), c.optInt("width", 640), c.optInt("height", 480),
                c.optString("filename", "video.mp4"), mime, false, true, null, null, f),
                arrayOf(), arrayOf(), null, 0, caption(c), MediaFlags.invert(c), MediaFlags.spoiler(c), false)
        }
        "file" -> {
            val f = file() ?: return textContent(c)
            TdApi.MessageDocument(TdApi.Document(c.optString("filename", "file"), mime, null, null, f), caption(c))
        }
        "voice" -> {
            val f = file() ?: return textContent(c)
            TdApi.MessageVoiceNote(TdApi.VoiceNote(c.optInt("duration_secs"), Waveform.fromWire(c.optJSONArray("waveform")), mime, null, f), caption(c), false)
        }
        "video_note" -> {
            val f = file() ?: return textContent(c)
            TdApi.MessageVideoNote(TdApi.VideoNote(c.optInt("duration_secs"), ByteArray(0), c.optInt("width", 240), null, null, null, f), false, false)
        }
        "location" -> TdApi.MessageLocation(TdApi.Location(c.optDouble("lat"), c.optDouble("long"), 0.0))
        "poll" -> polls.toTdPoll(uuid, self, this::idOf)?.let { TdApi.MessagePoll(it, null, null, false) } ?: textContent(c)
        // spec 005: стикер/GIF — тот же контент, что web/desktop; format по mime обязателен для X
        "sticker" -> {
            val f = file() ?: return textContent(c)
            val w = c.optInt("width", 512); val h = c.optInt("height", 512)
            val ref = c.optJSONObject("pack_ref")
            val setId = ref?.optString("name")?.takeIf { it.isNotEmpty() }?.let { EmojiDocId.packSetId(EmojiDocId.sanitizeName(it)) } ?: 0L
            val emoji = if (c.isNull("filename")) "🙂" else c.optString("filename").ifEmpty { "🙂" }
            TdApi.MessageSticker(TdApi.Sticker(f.id.toLong(), setId, w, h, emoji, PackIndex.formatFor(mime), TdApi.StickerFullTypeRegular(null),
                TdApi.Thumbnail(PackIndex.thumbnailFormatFor(mime), w, h, f), f), false)
        }
        "gif" -> {
            val f = file() ?: return textContent(c)
            TdApi.MessageAnimation(TdApi.Animation(c.optInt("duration_secs", 1), c.optInt("width", 240), c.optInt("height", 240),
                c.optString("filename", "animation.webm"), mime.ifEmpty { "video/webm" }, false, null, null, f), caption(c), MediaFlags.invert(c), MediaFlags.spoiler(c), false)
        }
        // "" — старые события без kind (текст); незнакомый вид (в т.ч. заглушка
        // движка v2 "unsupported", spec 007) — нативная заглушка X «не поддерживается»
        "text", "" -> textContent(c)
        // Служебное сообщение шва в чате (T080: участник группы v2 без записи администратора)
        "service" -> TdApi.MessageCustomServiceAction(c.optString("text"))
        // Режим «усиленная приватность» (L2-1): смена режима — видимое служебное сообщение чата,
        // текст EN/RU по локали; `anon` — автор записи группы неизвестен
        // spec 035 (US5, STUB_CRITICAL): вид из диапазона критичных номеров более новой версии — не «не
        // поддерживается», а «обновите приложение» (событие ядра с "critical": true, как desktop/web)
        "unsupported" -> if (c.optBoolean("critical")) TdApi.MessageCustomServiceAction(SeamText.of("stub_critical")!!) else TdApi.MessageUnsupported()
        L2Mode.CONTENT_KIND -> TdApi.MessageCustomServiceAction(
            L2Mode.serviceText(c, out, if (from.isEmpty() || c.optBoolean("anon")) "" else displayName(from)))
        // Сообщение вида, которого у X нет своим экраном (задание «Плана» и ответ, приглашение «Облака», статья, жалоба,
        // …): текст поля `text`, который заполнил отправитель (CONTENT-1: TASK-1, CLOUD-1, ARTICLE-1, REPORT-1). Знает
        // ли вид протокол — решает движок (`contentOfWire`); незнакомое ему — нативная заглушка X. Список видов шов не
        // ведёт — новый вид движка показывается так же.
        else -> if (org.parvane.core.ParvaneProtocol.contentOfWire(c.toString()) != null) textContent(c) else TdApi.MessageUnsupported()
    }
}

/** Текст с сущностями провода (bold/italic/…/custom_emoji — spec 005) и превью ссылки отправителя (`webpage`). */
private fun textContent(c: JSONObject): TdApi.MessageText =
    run {
        val txt = if (c.isNull("text")) "" else c.optString("text")
        val ents = Entities.fromWire(c.optJSONArray("entities"), txt)
        // MEDIA-2: карточка ссылки над текстом (`invert_media`)
        TdApi.MessageText(TdApi.FormattedText(txt, ents), LinkPreviews.linkPreviewOf(c.optJSONObject("webpage"), txt, ents),
            if (MediaFlags.invert(c)) TdApi.LinkPreviewOptions(false, "", false, false, true) else null)
    }


