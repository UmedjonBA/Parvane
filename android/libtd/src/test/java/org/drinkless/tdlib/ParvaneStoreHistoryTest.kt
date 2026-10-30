package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * spec 033 (HIST-1, READ-2) в шве TDLib: удалённое непрочитанное снимается со счётчика, счётчик чата выставляется от
 * маркера «прочитано до» журнала истории (событие read_state), догрузка истории его не раздувает, «удалить у всех» —
 * в личном чате любое сообщение, в группе — своё либо админу с правом. Чистый JVM, без эмулятора.
 */
class ParvaneStoreHistoryTest {
    private fun store(): ParvaneStore = ParvaneStore().apply { self = "me@local" }
    private fun text(t: String): JSONObject = JSONObject().put("kind", "text").put("text", t)
    private fun incoming(s: ParvaneStore, uuid: String, ts: Long, read: Boolean = false) =
        s.putMessage(uuid, "bob@local", "me@local", ts, text(uuid), out = false, read = read)

    @Test
    fun deletingUnreadIncomingLowersBadge() {
        val s = store()
        incoming(s, "u1", 100)
        incoming(s, "u2", 101)
        s.putMessage("u3", "me@local", "bob@local", 102, text("mine"), out = true)
        val chat = s.chatByAddress("bob@local")!!
        assertEquals(2, chat.unreadCount)
        val updates = s.removeMessages(listOf("u2", "u3"))
        assertEquals(1, chat.unreadCount)
        assertTrue(updates.any { it is TdApi.UpdateChatReadInbox && it.unreadCount == 1 })
        s.removeMessages(listOf("u1"))
        assertEquals(0, chat.unreadCount)
    }

    @Test
    fun deletingReadIncomingKeepsBadge() {
        val s = store()
        val m1 = incoming(s, "u1", 100)!!
        incoming(s, "u2", 101)
        val chat = s.chatByAddress("bob@local")!!
        s.markInboxRead(chat.id, m1.id)
        assertEquals(1, chat.unreadCount)
        val updates = s.removeMessages(listOf("u1"))
        assertEquals(1, chat.unreadCount)
        assertFalse(updates.any { it is TdApi.UpdateChatReadInbox })
    }

    @Test
    fun readStateFromMarkerSetsCountAndBoundary() {
        val s = store()
        val m1 = incoming(s, "u1", 100)!!
        val m2 = incoming(s, "u2", 101)!!
        incoming(s, "u3", 102)
        val chat = s.chatByAddress("bob@local")!!
        assertEquals(3, chat.unreadCount)
        // Прочитано на другом своём устройстве до u2
        val u = s.applyReadState("bob@local", 1, "u2")
        assertNotNull(u)
        assertEquals(1, chat.unreadCount)
        assertEquals(m2.id, chat.lastReadInboxMessageId)
        // То же состояние ещё раз — без апдейта; граница назад не уходит
        assertNull(s.applyReadState("bob@local", 1, "u2"))
        s.applyReadState("bob@local", 1, "u1")
        assertTrue(chat.lastReadInboxMessageId >= m2.id && m1.id < m2.id)
        // Всё прочитано — граница у последнего входящего, бейдж 0
        s.applyReadState("bob@local", 0, "")
        assertEquals(0, chat.unreadCount)
        assertEquals(s.messageByUuid("u3")!!.id, chat.lastReadInboxMessageId)
        // Неизвестный чат — ничего
        assertNull(s.applyReadState("nobody@local", 0, ""))
    }

    @Test
    fun lateHistoryDoesNotInflateBadgeOrMoveBoundary() {
        val s = store()
        incoming(s, "new", 200)
        val chat = s.chatByAddress("bob@local")!!
        assertEquals(1, chat.unreadCount)
        // Догрузка журналом: старое прочитанное приходит позже непрочитанного
        incoming(s, "old1", 100, read = true)
        incoming(s, "old2", 101, read = true)
        assertEquals(1, chat.unreadCount)
        assertEquals(0L, chat.lastReadInboxMessageId)
        // Новое устройство: вся история прочитана — счётчик 0
        val fresh = store()
        incoming(fresh, "a", 100, read = true)
        incoming(fresh, "b", 101, read = true)
        assertEquals(0, fresh.chatByAddress("bob@local")!!.unreadCount)
    }

    @Test
    fun deleteForEveryoneFollowsTelegramRules() {
        val s = store()
        incoming(s, "u1", 100)
        val direct = s.chatByAddress("bob@local")!!
        assertTrue(s.canDeleteForEveryone(direct.id, own = false)) // личный чат — и чужое
        val info = JSONObject("""{"group_id":"g1","name":"G","kind":"group","created_by":"alice@local","version":1,
            "members":[{"address":"alice@local","role":"owner"},{"address":"me@local","role":"member"}]}""")
        val (group, _, _) = s.ensureGroup("g1", "G", listOf("alice@local", "me@local"), "alice@local", emptyMap(), info)!!
        assertFalse(s.canDeleteForEveryone(group.id, own = false))
        assertTrue(s.canDeleteForEveryone(group.id, own = true))
        val adminInfo = JSONObject("""{"group_id":"g1","name":"G","kind":"group","created_by":"alice@local","version":2,
            "members":[{"address":"alice@local","role":"owner"},
                       {"address":"me@local","role":"admin","admin_rights":{"delete_messages":false}}]}""")
        s.ensureGroup("g1", "G", listOf("alice@local", "me@local"), "alice@local", mapOf("me@local" to "admin"), adminInfo)
        assertFalse(s.canDeleteForEveryone(group.id, own = false))
        val rightInfo = JSONObject(adminInfo.toString().replace("\"delete_messages\":false", "\"delete_messages\":true").replace("\"version\":2", "\"version\":3"))
        s.ensureGroup("g1", "G", listOf("alice@local", "me@local"), "alice@local", mapOf("me@local" to "admin"), rightInfo)
        assertTrue(s.canDeleteForEveryone(group.id, own = false))
    }
}
