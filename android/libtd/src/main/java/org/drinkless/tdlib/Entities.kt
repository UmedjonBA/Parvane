package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject

/**
 * spec 005: сущности форматирования — провод ↔ TdApi. Имена провода как у web
 * (`entities.ts`): bold, italic, underline, strike, code, pre(data=язык),
 * blockquote, spoiler, text_url(data=url), mention, custom_emoji(data=docId).
 * Смещения — UTF-16 (и у провода, и у TdApi). Неизвестные типы пропускаются.
 */
object Entities {
    fun fromWire(arr: JSONArray?): Array<TdApi.TextEntity> {
        if (arr == null) return emptyArray()
        val out = ArrayList<TdApi.TextEntity>()
        for (i in 0 until arr.length()) {
            val e = arr.optJSONObject(i) ?: continue
            val offset = e.optInt("offset", -1); val length = e.optInt("length", 0)
            if (offset < 0 || length <= 0) continue
            val data = if (e.isNull("data")) "" else e.optString("data")
            val type: TdApi.TextEntityType = when (e.optString("type")) {
                "bold" -> TdApi.TextEntityTypeBold()
                "italic" -> TdApi.TextEntityTypeItalic()
                "underline" -> TdApi.TextEntityTypeUnderline()
                "strike" -> TdApi.TextEntityTypeStrikethrough()
                "code" -> TdApi.TextEntityTypeCode()
                "pre" -> if (data.isNotEmpty()) TdApi.TextEntityTypePreCode(data) else TdApi.TextEntityTypePre()
                "blockquote" -> TdApi.TextEntityTypeBlockQuote()
                "spoiler" -> TdApi.TextEntityTypeSpoiler()
                "text_url" -> TdApi.TextEntityTypeTextUrl(data)
                "url" -> TdApi.TextEntityTypeUrl()
                "mention" -> TdApi.TextEntityTypeMention()
                "custom_emoji" -> TdApi.TextEntityTypeCustomEmoji(data.toLongOrNull() ?: continue)
                else -> continue
            }
            out.add(TdApi.TextEntity(offset, length, type))
        }
        return out.toTypedArray()
    }

    fun toWire(entities: Array<TdApi.TextEntity>?): JSONArray? {
        if (entities == null || entities.isEmpty()) return null
        val out = JSONArray()
        for (e in entities) {
            val t = e.type
            val o = JSONObject().put("offset", e.offset).put("length", e.length)
            when (t) {
                is TdApi.TextEntityTypeBold -> o.put("type", "bold")
                is TdApi.TextEntityTypeItalic -> o.put("type", "italic")
                is TdApi.TextEntityTypeUnderline -> o.put("type", "underline")
                is TdApi.TextEntityTypeStrikethrough -> o.put("type", "strike")
                is TdApi.TextEntityTypeCode -> o.put("type", "code")
                is TdApi.TextEntityTypePre -> o.put("type", "pre")
                is TdApi.TextEntityTypePreCode -> o.put("type", "pre").put("data", t.language ?: "")
                is TdApi.TextEntityTypeBlockQuote -> o.put("type", "blockquote")
                is TdApi.TextEntityTypeSpoiler -> o.put("type", "spoiler")
                is TdApi.TextEntityTypeTextUrl -> o.put("type", "text_url").put("data", t.url ?: "")
                is TdApi.TextEntityTypeUrl -> o.put("type", "url")
                is TdApi.TextEntityTypeMention -> o.put("type", "mention")
                is TdApi.TextEntityTypeCustomEmoji -> o.put("type", "custom_emoji").put("data", t.customEmojiId.toString())
                else -> continue
            }
            out.put(o)
        }
        return if (out.length() == 0) null else out
    }

    /** docId всех кастом-эмодзи в тексте (для подбора emoji_packs при отправке). */
    fun customEmojiIds(entities: Array<TdApi.TextEntity>?): List<Long> =
        entities?.mapNotNull { (it.type as? TdApi.TextEntityTypeCustomEmoji)?.customEmojiId }?.distinct() ?: emptyList()

    /** Первый URL в тексте (для превью ссылки): по сущностям url/text_url или простому поиску http(s)://. */
    fun firstUrl(text: String?, entities: Array<TdApi.TextEntity>?): String? {
        val t = text ?: return null
        entities?.forEach { e ->
            when (val ty = e.type) {
                is TdApi.TextEntityTypeTextUrl -> if (!ty.url.isNullOrEmpty()) return ty.url
                is TdApi.TextEntityTypeUrl -> if (e.offset + e.length <= t.length) return t.substring(e.offset, e.offset + e.length)
                else -> {}
            }
        }
        val m = URL_RE.find(t) ?: return null
        return m.value.trimEnd('.', ',', ';', ':', '!', '?', ')', ']', '}', '\'', '"', '»')
    }
    private val URL_RE = Regex("https?://[^\\s<>\"']+", RegexOption.IGNORE_CASE)
}
