package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Карточки с кнопками (spec 031, T030): клавиатуры task_offer/article/mod_report и разбор нажатия. */
class CardsTest {
    private fun labels(m: TdApi.ReplyMarkup?) = (m as TdApi.ReplyMarkupInlineKeyboard).rows.flatten().map { it.text }
    private fun datas(m: TdApi.ReplyMarkup?) = (m as TdApi.ReplyMarkupInlineKeyboard).rows.flatten()
        .map { String((it.type as TdApi.InlineKeyboardButtonTypeCallback).data) }

    @Test
    fun offerButtonsDependOnKindAndDecision() {
        val task = JSONObject().put("kind", "task_offer").put("name", "Купить хлеб")
        assertEquals(listOf("В план", "Отклонить"), labels(Cards.markup(task, "u1", out = false, ru = true)))
        assertEquals(listOf("pv:offeryes:u1", "pv:offerno:u1"), datas(Cards.markup(task, "u1", out = false, ru = true)))
        val event = JSONObject().put("kind", "task_offer").put("name", "Встреча").put("day", "2026-10-23").put("start", "15:00")
        assertTrue(Cards.offerIsEvent(event))
        assertEquals("Add to calendar", labels(Cards.markup(event, "u2", out = false, ru = false))[0])
        assertNull("своё задание без кнопок", Cards.markup(task, "u1", out = true))
        assertEquals(listOf("pv:offeropen:u1"), datas(Cards.markup(task, "u1", out = false, decided = true)))
        assertEquals(listOf("pv:none:u1"), datas(Cards.markup(task, "u1", out = false, decided = false)))
    }

    @Test
    fun modReportOnlyWhenCheckedAndArticleAlways() {
        val report = JSONObject().put("kind", "mod_report").put("text", "⚠️ спам")
        assertNull(Cards.markup(report, "r1", out = false, modChecked = false))
        assertNotNull(Cards.markup(report, "r1", out = false, modChecked = true))
        val article = JSONObject().put("kind", "article").put("title", "Заметка").put("markdown", "См. [[Другая|другую]]")
        assertEquals(2, labels(Cards.markup(article, "a1", out = true)).size)
        assertEquals("Заметка\n\nСм. другую", Cards.articleText(article))
        assertNull(Cards.markup(JSONObject().put("kind", "text"), "t", out = false))
    }

    @Test
    fun pressParsing() {
        assertEquals(Cards.Press("offeryes", "0191-ab"), Cards.parse("pv:offeryes:0191-ab".toByteArray()))
        assertNull(Cards.parse("other".toByteArray()))
        assertNull(Cards.parse(null))
    }
}
