package org.drinkless.tdlib

/** Синхронные функции TDLib, которые X зовёт через `Client.execute` (ревью 7 ноя 2026). Чистый JVM-класс. */
object SeamExec {
    /** Флаг страны по коду ISO 3166-1 alpha-2 (региональные индикаторы); иной код — "". */
    fun flagEmoji(code: String?): String {
        val c = (code ?: "").trim().uppercase()
        if (c.length != 2 || !c.all { it in 'A'..'Z' }) return ""
        return c.map { String(Character.toChars(0x1F1E6 + (it - 'A'))) }.joinToString("")
    }
}
