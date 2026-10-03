package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.parvane.core.ParvaneProtocol
import java.nio.file.Files

/**
 * Журнал личного состояния в шве (spec 007, T098): локальные папки/черновики/
 * архив/отложенные → снимок StateSnapshot (тексты и содержимое — байтами
 * протокола через движок) → обратно на другое «устройство». Сведение и
 * шифрование — в движке (STATE-1, векторы state/merge — ProtocolV2SeamTest).
 */
class StateJournalTest {
    private val ids = mapOf("bob@local" to 11L, "carol@local" to 12L, "v2g:" + "ab".repeat(16) to -21L)

    private fun resolver(knownV2: Boolean = true) = object : StateJournal.Resolver {
        override fun addressOf(chatId: Long) = ids.entries.firstOrNull { it.value == chatId }?.key
        override fun chatIdOf(address: String) = ids[address]
        override fun domain() = "local"
        override fun isKnownV2Group(hex: String) = knownV2 && ids.containsKey("v2g:$hex")
    }

    private fun tmp() = Files.createTempDirectory("pv-state").toFile()

    /** T132 (FR-039, правило STATE-2): настройки уведомлений — вид журнала, чужие поля записи не стираются. */
    @Test
    fun notifySettingsRoundTripThroughSnapshot() {
        val a = tmp()
        val j = StateJournal(ParvaneProtocol.stateCodec, resolver())
        val mine = StateJournal.NotifyView(
            JSONObject().put("groups", JSONObject().put("mutedUntil", 2147483647L)),
            JSONObject().put("bob@local", JSONObject().put("mutedUntil", 1900000000L)))
        val snap = j.build(ChatLocalState(a), ScheduledQueue(a) { 1000L }, emptySet(), mine)
        val entry = snap.getJSONArray("notify").getJSONObject(0)
        assertEquals("bob@local", entry.getJSONObject("peer").getJSONObject("user").getString("address"))
        assertEquals("1900000000000", entry.getJSONObject("settings").getString("mute_until_ms"))
        assertEquals("2147483647000", snap.getJSONObject("notify_defaults").getJSONObject("groups").getString("mute_until_ms"))
        assertFalse("умолчание, которого нет ни у шва, ни в журнале, не выдумывается", snap.getJSONObject("notify_defaults").has("users"))
        assertTrue(j.hasNotify(snap))
        assertFalse(j.hasNotify(JSONObject()))

        // Другое «устройство» без настроек: журнал → блоб для applyNotifyBlob
        val b = tmp()
        val other = StateJournal(ParvaneProtocol.stateCodec, resolver())
        val empty = StateJournal.NotifyView(JSONObject(), JSONObject())
        val ch = other.project(snap, ChatLocalState(b), ScheduledQueue(b) { 1000L }, HashSet(), empty)
        assertEquals(1900000000L, ch.notify!!.getJSONObject("exceptions").getJSONObject("bob@local").getLong("mutedUntil"))
        assertEquals(2147483647L, ch.notify!!.getJSONObject("defaults").getJSONObject("groups").getLong("mutedUntil"))
        // То же состояние — изменений нет; без вида notify (null) проекция настройки не трогает
        assertFalse(other.project(snap, ChatLocalState(b), ScheduledQueue(b) { 1000L }, HashSet(), mine).any())
        assertFalse(other.project(snap, ChatLocalState(b), ScheduledQueue(b) { 1000L }, HashSet(), null).any())

        // Запись другого клиента с полями, которых шов не ведёт (звук, тихий режим): правка мута их сохраняет
        val web = JSONObject(snap.toString())
        web.getJSONArray("notify").getJSONObject(0).getJSONObject("settings").put("sound", "chime").put("silent", true)
        other.project(web, ChatLocalState(b), ScheduledQueue(b) { 1000L }, HashSet(), mine)
        val unmuted = StateJournal.NotifyView(JSONObject(), JSONObject().put("bob@local", JSONObject().put("mutedUntil", 0L)))
        val rebuilt = other.build(ChatLocalState(b), ScheduledQueue(b) { 1000L }, emptySet(), unmuted)
            .getJSONArray("notify").getJSONObject(0).getJSONObject("settings")
        assertEquals("0", rebuilt.getString("mute_until_ms"))
        assertEquals("chime", rebuilt.getString("sound"))
        assertTrue(rebuilt.getBoolean("silent"))

        // Исключение, которого в журнале больше нет, снимается
        val gone = other.project(JSONObject(), ChatLocalState(b), ScheduledQueue(b) { 1000L }, HashSet(), mine)
        assertEquals(0L, gone.notify!!.getJSONObject("exceptions").getJSONObject("bob@local").getLong("mutedUntil"))
        a.deleteRecursively(); b.deleteRecursively()
    }

    @Test
    fun localStateRoundTripsThroughSnapshot() {
        val a = tmp()
        val local = ChatLocalState(a)
        val queue = ScheduledQueue(a) { 1000L }
        local.folders.create(TdApi.ChatFolder(TdApi.ChatFolderName(TdApi.FormattedText("Работа", arrayOf()), false), null, 3, false,
            longArrayOf(), longArrayOf(11L, -21L), longArrayOf(12L), false, false, true, true, false, true, false, false))
        local.setDraft(11L, JSONObject().put("text", "черновик 🙂").put("date", 1700000000))
        local.setArchived(12L, true)
        queue.add("0192f0e4-1a2b-7c3d-8e4f-001122334455", 11L, "bob@local", JSONObject().put("kind", "text").put("text", "позже"), null, null, 5000L)
        val j = StateJournal(ParvaneProtocol.stateCodec, resolver())
        val snap = j.build(local, queue, setOf("carol@local"))
        assertEquals(1, snap.getJSONArray("blocked").length())
        assertEquals(1, snap.getJSONArray("folders").length())
        assertEquals(2, snap.getJSONArray("folders").getJSONObject(0).getJSONArray("include_peers").length())
        assertEquals(1, snap.getJSONArray("drafts").length())
        assertEquals(1, snap.getJSONArray("archived").length())
        assertEquals(1, snap.getJSONArray("scheduled").length())

        // Другое «устройство»: пустые файлы → снимок журнала
        val b = tmp()
        val local2 = ChatLocalState(b)
        val queue2 = ScheduledQueue(b) { 1000L }
        val blocked2 = HashSet<String>()
        val ch = j.project(snap, local2, queue2, blocked2)
        assertTrue(ch.folders)
        assertEquals(setOf("carol@local"), blocked2)
        val f = local2.folders.all().single()
        assertEquals("Работа", f.title)
        assertEquals(listOf(11L, -21L), f.included)
        assertEquals(listOf(12L), f.excluded)
        assertTrue(f.includeContacts && f.includeBots)
        assertEquals("черновик 🙂", local2.draftOf(11L)!!.getString("text"))
        assertTrue(local2.isArchived(12L))
        val s = queue2.all().single()
        assertEquals("0192f0e4-1a2b-7c3d-8e4f-001122334455", s.uuid)
        assertEquals("позже", s.content.getString("text"))
        assertEquals(5000L, s.due)
        // Повторная проекция того же снимка — изменений нет
        assertFalse(j.project(snap, local2, queue2, blocked2).any())
    }

    @Test
    fun removedInJournalLeavesLocalFiles() {
        val a = tmp()
        val local = ChatLocalState(a)
        val queue = ScheduledQueue(a) { 1000L }
        local.setArchived(12L, true)
        queue.add("0192f0e4-1a2b-7c3d-8e4f-001122334466", 11L, "bob@local", JSONObject().put("kind", "text").put("text", "x"), null, null, 5000L)
        val j = StateJournal(ParvaneProtocol.stateCodec, resolver())
        // Журнал: архив пуст, отложенное отправлено другим устройством
        val op = StateJournal.uuidToB64("0192f0e4-1a2b-7c3d-8e4f-001122334466")!!
        val ch = j.project(JSONObject().put("scheduled_sent", JSONArray().put(op)), local, queue)
        assertFalse(local.isArchived(12L))
        assertTrue(queue.all().isEmpty())
        assertEquals(1, ch.scheduledRemoved.size)
    }

    @Test
    fun groupPeersKeepV2AndV1Addresses() {
        val j = StateJournal(ParvaneProtocol.stateCodec, resolver())
        val v2 = j.peerOf("v2g:" + "ab".repeat(16))!!
        assertEquals("v2g:" + "ab".repeat(16), j.addressOf(v2))
        val v1 = j.peerOf("0192f0e4-1a2b-7c3d-8e4f-001122334455")!!
        assertEquals("0192f0e4-1a2b-7c3d-8e4f-001122334455", j.addressOf(v1))
        assertEquals("bob@local", j.addressOf(j.peerOf("bob@local")))
    }
}
