package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Conformance GROUP-1 и просмотр сведений группы (spec 003) в шве TDLib:
 * права по умолчанию → ChatPermissions, права админа → ChatAdministratorRights,
 * описание → BasicGroupFullInfo.description, применение по ревизии `version`.
 * Чистый JVM, без эмулятора.
 */
class ParvaneStoreGroupTest {
    private fun info(version: Long, name: String = "G", about: String = "", perms: String = "{}", avatar: String? = null,
                     bobRights: String? = null): JSONObject {
        val members = """[{"address":"alice@local","role":"owner"},{"address":"bob@local","role":"admin"${if (bobRights != null) ",\"admin_rights\":$bobRights" else ""}},{"address":"carol@local","role":"member"}]"""
        return JSONObject("""{"group_id":"g1","name":"$name","kind":"group","created_by":"alice@local","members":$members,
            "about":"$about","default_permissions":$perms,"version":$version${if (avatar != null) ",\"avatar\":\"$avatar\"" else ""}}""")
    }

    private fun store(): ParvaneStore = ParvaneStore().apply { self = "carol@local" }

    @Test
    fun defaultPermissionsMapToChatPermissions() {
        val s = store()
        val (chat, _, created) = s.ensureGroup("g1", "G", listOf("alice@local", "bob@local", "carol@local"), "alice@local",
            mapOf("bob@local" to "admin"), info(1, perms = """{"send_media":false,"pin_messages":true}"""))!!
        assertTrue(created)
        assertTrue(chat.permissions.canSendBasicMessages)
        assertFalse(chat.permissions.canSendPhotos)
        assertFalse(chat.permissions.canSendVoiceNotes)
        assertTrue(chat.permissions.canSendOtherMessages) // стикеры/GIF не выключены
        assertTrue(chat.permissions.canPinMessages)
        assertFalse(chat.permissions.canChangeInfo)
        assertTrue(chat.permissions.canInviteUsers)
        // send_messages выключает всё
        val (chat2, _, _) = s.ensureGroup("g1", "G", listOf("alice@local", "bob@local", "carol@local"), "alice@local",
            mapOf("bob@local" to "admin"), info(2, perms = """{"send_messages":false}"""))!!
        assertFalse(chat2.permissions.canSendBasicMessages)
        assertFalse(chat2.permissions.canSendPolls)
    }

    @Test
    fun adminRightsMapGranularly() {
        val s = store()
        s.ensureGroup("g1", "G", listOf("alice@local", "bob@local", "carol@local"), "alice@local", mapOf("bob@local" to "admin"),
            info(1, bobRights = """{"change_info":false,"delete_messages":false,"ban_users":false,"invite_users":false,"pin_messages":true,"add_admins":false}"""))
        val g = s.group("g1")!!
        val bob = s.chatMember(g, "bob@local").status as TdApi.ChatMemberStatusAdministrator
        assertTrue(bob.rights.canPinMessages)
        assertFalse(bob.rights.canRestrictMembers)
        assertFalse(bob.rights.canPromoteMembers)
        assertFalse(bob.rights.canChangeInfo)
        // legacy-админ без набора — полный
        s.ensureGroup("g1", "G", listOf("alice@local", "bob@local", "carol@local"), "alice@local", mapOf("bob@local" to "admin"), info(2))
        val legacy = s.chatMember(s.group("g1")!!, "bob@local").status as TdApi.ChatMemberStatusAdministrator
        assertTrue(legacy.rights.canRestrictMembers && legacy.rights.canPromoteMembers)
        assertTrue(s.chatMember(s.group("g1")!!, "alice@local").status is TdApi.ChatMemberStatusCreator)
        assertTrue(s.chatMember(s.group("g1")!!, "carol@local").status is TdApi.ChatMemberStatusMember)
    }

    @Test
    fun aboutAndPhotoReachFullInfoAndChat() {
        val s = store()
        s.ensureGroup("g1", "G", listOf("alice@local", "carol@local"), "alice@local", emptyMap(), info(1, about = "о группе", avatar = "f-1"))
        val g = s.group("g1")!!
        assertEquals("о группе", s.basicGroupFullInfo(g).description)
        assertEquals("f-1", g.avatarFileId)
        assertNull(s.chatById(g.chatId)!!.photo)
        val chat = s.setGroupPhoto("g1", "f-1", "/tmp/f-1.jpg")
        assertNotNull(chat!!.photo)
        assertNull(s.clearGroupPhoto("g1")!!.photo)
    }

    // spec 004: заявки → Chat.pendingJoinRequests; основная ссылка → BasicGroupFullInfo.inviteLink
    @Test
    fun pendingRequestsAndPrimaryLinkReachNativeObjects() {
        val s = store()
        val (chat, _, _) = s.ensureGroup("g1", "G", listOf("alice@local", "carol@local"), "alice@local", emptyMap(),
            JSONObject("""{"group_id":"g1","name":"G","created_by":"alice@local","members":[],"version":1,"pending_requests":2}"""))!!
        assertNotNull(chat.pendingJoinRequests)
        assertEquals(2, chat.pendingJoinRequests!!.totalCount)
        val g = s.group("g1")!!
        assertNull(s.basicGroupFullInfo(g).inviteLink)
        g.primaryInviteLink = s.inviteLinkOf(JSONObject("""{"token":"0123456789abcdef0123456789abcdef","created_by":"alice@local","is_primary":true}"""))
        assertEquals("https://parvane.invite/0123456789abcdef0123456789abcdef", s.basicGroupFullInfo(g).inviteLink!!.inviteLink)
        // участнику pending_requests не отдаётся (-1) → 0 и без строки заявок
        val (chat2, _, _) = s.ensureGroup("g1", "G", listOf("alice@local", "carol@local"), "alice@local", emptyMap(),
            JSONObject("""{"group_id":"g1","name":"G","created_by":"alice@local","members":[],"version":2,"pending_requests":-1}"""))!!
        assertNull(chat2.pendingJoinRequests)
    }

    @Test
    fun staleVersionIsIgnored() {
        val s = store()
        assertNotNull(s.ensureGroup("g1", "v5", listOf("alice@local", "carol@local"), "alice@local", emptyMap(), info(5, name = "v5")))
        assertNull(s.ensureGroup("g1", "v4", listOf("alice@local", "carol@local"), "alice@local", emptyMap(), info(4, name = "v4")))
        assertEquals("v5", s.chatById(s.group("g1")!!.chatId)!!.title)
        assertNotNull(s.ensureGroup("g1", "v5-again", listOf("alice@local", "carol@local"), "alice@local", emptyMap(), info(5, name = "v5-again")))
        assertEquals("v5-again", s.chatById(s.group("g1")!!.chatId)!!.title)
        assertNotNull(s.ensureGroup("g1", "v6", listOf("alice@local", "carol@local"), "alice@local", emptyMap(), info(6, name = "v6")))
        assertEquals(6L, s.group("g1")!!.version)
        // старый сервер без ревизии при известной — пропуск
        assertNull(s.ensureGroup("g1", "old", listOf("alice@local", "carol@local"), "alice@local", emptyMap(), JSONObject("""{"group_id":"g1"}""").put("version", -1)))
    }
}
