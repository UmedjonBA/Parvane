package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * spec 036 T035 (ENGINE-1): лента X — страницами модели (GetChatHistory → historyPage), список чатов — видом модели
 * (`ChatView`). В памяти шва только показанное; id сообщения — из места строки модели, поэтому страница старых строк,
 * загруженная позже, встаёт ниже показанного, а граница «прочитано до» известна до загрузки своей строки. Модель здесь —
 * поддельный pager с той же семантикой страниц (строго старше/новее якоря). Имена и тексты — выдуманные.
 */
class ParvaneStoreModelPagesTest {
    private val base = 1_800_000_000_000L
    private fun row(n: Int, read: Boolean = true): JSONObject = JSONObject().put("id", "00000000-0000-7000-8000-%012d".format(n))
        .put("from", "bob@local").put("to", "me@local").put("ts", (base + n * 1000L) / 1000).put("out", false).put("read", read)
        .put("order", base + n * 1000L).put("content", JSONObject().put("kind", "text").put("text", "строка $n"))

    private fun storeWith(rows: List<JSONObject>, calls: MutableList<String>): ParvaneStore {
        val s = ParvaneStore().apply { self = "me@local" }
        s.pager = { _, anchor, direction, limit ->
            calls += "$direction:${anchor.takeLast(3)}:$limit"
            val at = rows.indexOfFirst { it.optString("id") == anchor }
            val (from, to) = when {
                anchor.isEmpty() -> maxOf(0, rows.size - limit) to rows.size
                direction == "newer" -> (at + 1) to minOf(rows.size, at + 1 + limit)
                direction == "around" -> at to minOf(rows.size, at + limit)
                else -> maxOf(0, at - limit) to at
            }
            ParvaneStore.Page(rows.subList(from, to), from > 0, to < rows.size)
        }
        s.materialize = { ev ->
            s.messageByUuid(ev.optString("id")) ?: s.putMessage(ev.optString("id"), ev.optString("from"), ev.optString("to"),
                ev.optLong("ts"), ev.getJSONObject("content"), ev.optBoolean("out"), read = ev.optBoolean("read"), order = ev.optLong("order"))
        }
        return s
    }

    private fun texts(m: TdApi.Messages) = m.messages.map { (it.content as TdApi.MessageText).text.text }

    @Test
    fun historyPagesFromModelAndOlderPageSortsBelow() {
        val rows = (1..10).map(::row)
        val calls = ArrayList<String>()
        val s = storeWith(rows, calls)
        // Список чатов: в памяти только последняя строка
        s.materialize!!(rows.last())
        val chat = s.chatByAddress("bob@local")!!
        assertEquals("строка 10", (chat.lastMessage!!.content as TdApi.MessageText).text.text)
        // Лента с конца: три новых (без строки в памяти X их бы не увидел)
        val first = s.history(chat.id, 0, 0, 3)
        assertEquals(listOf("строка 10", "строка 9", "строка 8"), texts(first))
        // Листание назад от самой старой показанной: строго старше
        val older = s.history(chat.id, first.messages.last().id, 0, 3)
        assertEquals(listOf("строка 7", "строка 6", "строка 5"), texts(older))
        // Загруженная позже старая строка — ниже показанного (id по месту в ленте), последнее сообщение чата прежнее
        assertTrue(older.messages.first().id < first.messages.last().id)
        assertEquals("строка 10", (chat.lastMessage!!.content as TdApi.MessageText).text.text)
        // Окно вокруг: якорь и новее (отрицательное смещение)
        val around = s.history(chat.id, older.messages.last().id, -2, 4)
        assertEquals(listOf("строка 6", "строка 5", "строка 4", "строка 3"), texts(around))
        assertTrue("страницы просили модель: $calls", calls.any { it.startsWith("older:") } && calls.any { it.startsWith("newer:") })
    }

    @Test
    fun readBoundaryKnownBeforeRowIsLoaded() {
        val rows = (1..5).map { row(it, read = false) }
        val s = storeWith(rows, ArrayList())
        s.materialize!!(rows.last())
        val chat = s.chatByAddress("bob@local")!!
        // Граница прочтения — строка 2, которой в памяти нет: id по её месту в модели
        s.applyReadState("bob@local", 3, rows[1].optString("id"), rows[1].optLong("order"))
        val boundary = chat.lastReadInboxMessageId
        assertTrue(boundary > 0)
        // Строка подгружена страницей — тот же id; страница «от границы» (X открывает чат с непрочитанного) идёт от неё
        val page = s.history(chat.id, boundary, -1, 3)
        assertEquals(boundary, s.messageByUuid(rows[1].optString("id"))!!.id)
        assertEquals(listOf("строка 2", "строка 1"), texts(page))
    }

    @Test
    fun chatViewDrivesPositionsMarkAndRemoval() {
        val rows = (1..2).map(::row)
        val s = storeWith(rows, ArrayList())
        s.local = ChatLocalState(java.nio.file.Files.createTempDirectory("pv-local").toFile())
        s.materialize!!(rows.last())
        val chat = s.chatByAddress("bob@local")!!
        // Архив из модели: позиция переезжает из главного списка (снятие из прежнего — нулевая позиция)
        var ups = s.applyModelChat(chat.id, ParvaneStore.ModelChat(rows.last().optLong("order"), 0, true, true, 0, 0))
        assertTrue(chat.positions[0].list is TdApi.ChatListArchive)
        assertTrue(ups.any { it is TdApi.UpdateChatPosition && it.position.list is TdApi.ChatListMain && it.position.order == 0L })
        assertTrue(chat.isMarkedAsUnread)
        // Закреп из модели: порядок закреплённых — место в закрепе модели
        ups = s.applyModelChat(chat.id, ParvaneStore.ModelChat(rows.last().optLong("order"), 1, false, false, base * 2, 0))
        assertTrue(chat.positions[0].isPinned && chat.positions[0].list is TdApi.ChatListMain)
        assertFalse(chat.isMarkedAsUnread)
        assertTrue("мут модели — в настройках чата", chat.notificationSettings.muteFor > 0)
        // Снятие моделью строки с сообщением — не трогает (своё отправляемое), без сообщений — позиция 0
        assertTrue(s.removeModelChat(chat.id).isEmpty())
        s.applyModelChat(chat.id, ParvaneStore.ModelChat(1, 0, false, false, 0, 0))
        s.removeMessages(rows.map { it.optString("id") })
        val gone = s.removeModelChat(chat.id)
        assertNotNull(gone.firstOrNull { it is TdApi.UpdateChatPosition && it.position.order == 0L })
    }

    @Test
    fun messageIdsNeverLookScheduled() {
        // Удаление в X отделяет отложенные по диапазону id: id ленты (по месту строки модели) в него не попадает —
        // иначе «удалить» сообщения ленты молча уходило в очередь отложенных (a036x, tgx_history_sync_flow)
        val q = ScheduledQueue(java.nio.file.Files.createTempDirectory("pv-sched").toFile())
        assertTrue(q.isScheduledId(ScheduledQueue.ID_BASE))
        for (order in listOf(base, base + 365L * 24 * 3600 * 1000, 1_000_000_000_001L)) {
            assertFalse("id ленты $order", q.isScheduledId(MessageIds.of(order, "00000000-0000-7000-8000-000000000001")))
        }
    }
}
