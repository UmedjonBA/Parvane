package org.drinkless.tdlib

import org.json.JSONObject

/**
 * Карточки сообщений с кнопками (spec 031, T030; как desktop CardMarkup): задание в чат (`task_offer`, TASK-1) —
 * «В план»/«В календарь» и «Отклонить»; статья (`article`, ARTICLE-1) — «Читать» и «В заметки»; жалоба админу
 * (`mod_report`, REPORT-1, только проверенная по своим данным) — «Удалить сообщения» и «Заблокировать». Кнопки —
 * inline-клавиатура штатного рендера X; нажатие приходит `GetCallbackQueryAnswer` с данными `pv:<действие>:<uuid>`.
 * Чистый JVM-класс: тексты — по языку, решение по заданию — параметром.
 */
object Cards {
    const val PREFIX = "pv:"

    data class Press(val action: String, val uuid: String)

    fun parse(data: ByteArray?): Press? {
        val text = data?.let { String(it) } ?: return null
        if (!text.startsWith(PREFIX)) return null
        val rest = text.removePrefix(PREFIX)
        val i = rest.indexOf(':')
        if (i <= 0) return null
        return Press(rest.substring(0, i), rest.substring(i + 1))
    }

    private fun button(text: String, action: String, uuid: String) =
        TdApi.InlineKeyboardButton(text, 0L, TdApi.ButtonStyleDefault(), TdApi.InlineKeyboardButtonTypeCallback("$PREFIX$action:$uuid".toByteArray()))

    private fun row(vararg b: TdApi.InlineKeyboardButton) = TdApi.ReplyMarkupInlineKeyboard(arrayOf(arrayOf(*b)), false)

    /** Задание — событие (есть день и время начала, нет шагов и срока; как ядро `offerKind`) либо задача. */
    fun offerIsEvent(content: JSONObject): Boolean {
        fun has(k: String) = !content.isNull(k) && content.optString(k).isNotEmpty()
        return has("day") && has("start") && (content.optJSONArray("steps")?.length() ?: 0) == 0 && !has("due")
    }

    /**
     * Клавиатура карточки; null — у содержимого её нет. [decided] — решение по заданию на этом устройстве
     * (true — принято, false — отклонено). [modChecked] — жалоба прошла проверку своими данными.
     */
    fun markup(content: JSONObject, uuid: String, out: Boolean, decided: Boolean? = null, modChecked: Boolean = false,
               ru: Boolean = SeamText.isRu()): TdApi.ReplyMarkup? = when (content.optString("kind")) {
        "task_offer" -> if (out) null else when (decided) {
            true -> row(button(if (ru) "В «Плане»" else "In Plan", "offeropen", uuid))
            false -> row(button(if (ru) "Отклонено" else "Declined", "none", uuid))
            null -> row(
                button(if (offerIsEvent(content)) (if (ru) "В календарь" else "Add to calendar") else (if (ru) "В план" else "Add to plan"), "offeryes", uuid),
                button(if (ru) "Отклонить" else "Decline", "offerno", uuid))
        }
        "article" -> row(button(if (ru) "Читать" else "Read", "article", uuid), button(if (ru) "В заметки" else "Save to notes", "articlesave", uuid))
        "mod_report" -> if (out || !modChecked) null else
            row(button(if (ru) "Удалить сообщения" else "Delete messages", "moddel", uuid), button(if (ru) "Заблокировать" else "Ban", "modban", uuid))
        else -> null
    }

    /** Текст статьи для окна чтения (заголовок + Markdown, без разметки ссылок заметок). */
    fun articleText(content: JSONObject, limit: Int = 3800): String {
        val title = content.optString("title")
        val body = content.optString("markdown").ifEmpty { content.optString("text") }
            .replace(Regex("""\[\[([^\]|]+)(\|([^\]]+))?]]""")) { m -> m.groupValues[3].ifEmpty { m.groupValues[1] } }
        val all = if (title.isNotEmpty()) "$title\n\n$body" else body
        return if (all.length > limit) all.take(limit) + "…" else all
    }
}
