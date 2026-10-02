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
