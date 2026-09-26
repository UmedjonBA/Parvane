package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * spec 004 (US7): ссылки/превью/вступление/заявки провода → объекты TdApi для
 * экранов Telegram X (ChatLinksController, JoinRequestsComponent, TdlibUi).
 * Чистый JVM, без эмулятора и JNI.
 */
class ParvaneStoreInvitesTest {
    private fun store(): ParvaneStore = ParvaneStore().apply {
        self = "alice@local"
        ensureGroup("g1", "G", listOf("alice@local", "bob@local"), "alice@local", emptyMap(),
            JSONObject("""{"group_id":"g1","name":"G","kind":"group","created_by":"alice@local","members":[],"version":1}"""))
    }

    @Test
    fun inviteTokenAcceptsThreeFormats() {
        val t = "0123456789abcdef0123456789abcdef"
        assertEquals(t, ParvaneStore.inviteTokenOf("https://parvane.invite/$t"))
        assertEquals(t, ParvaneStore.inviteTokenOf("http://parvane.invite/$t?x=1"))
        assertEquals(t, ParvaneStore.inviteTokenOf("https://web.example/app/#+$t"))
        assertEquals(t, ParvaneStore.inviteTokenOf("  $t  "))
        assertNull(ParvaneStore.inviteTokenOf("https://parvane.invite/nope"))
        assertNull(ParvaneStore.inviteTokenOf("https://t.me/+abc"))
        assertNull(ParvaneStore.inviteTokenOf(null))
        assertEquals("https://parvane.invite/$t", ParvaneStore.buildInviteLink(t))
    }

    @Test
    fun inviteLinkMapsAllFields() {
        val s = store()
        val l = s.inviteLinkOf(JSONObject("""{"token":"0123456789abcdef0123456789abcdef","created_by":"alice@local","created_at":100,
            "title":"Weekend","expires_at":200,"max_uses":5,"uses":2,"request_needed":true,"revoked":false,"revoked_at":0,
            "state":"active","is_primary":false,"pending_requests":1}"""))
        assertEquals("https://parvane.invite/0123456789abcdef0123456789abcdef", l.inviteLink)
        assertEquals("Weekend", l.name)
        assertEquals(s.idOf("alice@local"), l.creatorUserId)
        assertEquals(100, l.date)
        assertEquals(200, l.expirationDate)
        assertEquals(5, l.memberLimit)
        assertEquals(2, l.memberCount)
        assertEquals(1, l.pendingJoinRequestCount)
        assertTrue(l.createsJoinRequest)
        assertFalse(l.isPrimary)
        assertFalse(l.isRevoked)
        assertNull(l.subscriptionPricing)
        val primary = s.inviteLinkOf(JSONObject("""{"token":"ffffffffffffffffffffffffffffffff","created_by":"alice@local","is_primary":true,"revoked":true}"""))
        assertTrue(primary.isPrimary && primary.isRevoked)
        assertEquals("", primary.name)
    }

    @Test
    fun inviteLinkInfoFromCheck() {
        val s = store()
        val info = s.inviteLinkInfoOf(JSONObject("""{"ok":true,"group_id":"g1","name":"Team","kind":"group","about":"о нас",
            "members_count":4,"request_needed":true,"already_member":false,"pending":false}"""))
        assertEquals("Team", info.title)
        assertEquals("о нас", info.description)
        assertEquals(4, info.memberCount)
        assertTrue(info.createsJoinRequest)
        assertTrue(info.type is TdApi.InviteLinkChatTypeBasicGroup)
        assertEquals(0L, info.chatId)
        val member = s.inviteLinkInfoOf(JSONObject("""{"ok":true,"group_id":"g1","name":"Team","kind":"channel","already_member":true}"""))
        assertEquals(s.group("g1")!!.chatId, member.chatId)
        assertTrue(member.type is TdApi.InviteLinkChatTypeChannel)
    }

    @Test
    fun joinResultVariants() {
        val s = store()
        val ok = s.joinResultOf(JSONObject("""{"ok":true,"group_id":"g1","name":"G"}"""))
        assertTrue(ok is TdApi.ChatJoinResultSuccess)
        assertEquals(s.group("g1")!!.chatId, (ok as TdApi.ChatJoinResultSuccess).chatId)
        assertTrue(s.joinResultOf(JSONObject("""{"ok":true,"group_id":"g1","pending":true}""")) is TdApi.ChatJoinResultRequestSent)
        assertTrue(s.joinResultOf(JSONObject("""{"ok":false,"error_code":"declined"}""")) is TdApi.ChatJoinResultDeclined)
        for (code in listOf("invalid", "revoked", "expired", "exhausted", "banned")) {
            val e = s.joinResultOf(JSONObject("""{"ok":false,"error":"ссылка","error_code":"$code"}"""))
            assertTrue(e is TdApi.Error)
            assertEquals(code, (e as TdApi.Error).message)
        }
    }

    @Test
    fun joinRequestsMap() {
        val s = store()
        val r = s.joinRequestsOf(JSONArray("""[{"member":"carol@local","invite":"t1","created_at":7},{"member":"dave@local","invite":"t1","created_at":8}]"""))
        assertEquals(2, r.totalCount)
        assertEquals(s.idOf("carol@local"), r.requests[0].userId)
        assertEquals(7, r.requests[0].date)
        assertEquals("", r.requests[0].bio)
        assertEquals(0, s.joinRequestsOf(null).totalCount)
    }

    @Test
    fun roleOfMembers() {
        val s = store()
        s.ensureGroup("g1", "G", listOf("alice@local", "bob@local", "carol@local"), "alice@local", mapOf("bob@local" to "admin"),
            JSONObject("""{"group_id":"g1","name":"G","created_by":"alice@local","members":[],"version":2}"""))
        val g = s.group("g1")!!
        assertEquals("owner", s.roleOf(g, "alice@local"))
        assertEquals("admin", s.roleOf(g, "bob@local"))
        assertEquals("member", s.roleOf(g, "carol@local"))
        assertNull(s.roleOf(g, "eve@local"))
        assertNull(s.roleOf(null, "alice@local"))
    }
}
