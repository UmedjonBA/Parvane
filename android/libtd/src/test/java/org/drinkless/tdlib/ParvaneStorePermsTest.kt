package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Conformance GROUP-2 в шве TDLib (spec 004): та же формула прав по типу
 * содержимого, что в web/desktop — кейсы читаются из conformance/sync-rules.json,
 * плюс обратные маппинги ChatPermissions/ChatAdministratorRights → провод.
 */
class ParvaneStorePermsTest {
    private fun rules(): JSONObject {
        // Gradle запускает тест из каталога модуля android/libtd
        val candidates = listOf(File("../../conformance/sync-rules.json"), File("../../../conformance/sync-rules.json"))
        val f = candidates.firstOrNull { it.exists() } ?: throw AssertionError("нет conformance/sync-rules.json рядом с модулем")
        val doc = JSONObject(f.readText())
        val arr = doc.getJSONArray("rules")
        for (i in 0 until arr.length()) if (arr.getJSONObject(i).getString("id") == "GROUP-2") return arr.getJSONObject(i)
        throw AssertionError("нет правила GROUP-2")
    }

    @Test
    fun conformanceCasesGroup2() {
        val cases = rules().getJSONArray("cases")
        assertTrue(cases.length() >= 10)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val role = if (c.isNull("role")) null else c.getString("role")
            val allowed = c.getBoolean("allowed")
            if (role != "member") {
                // владелец/админ/неизвестная роль — фильтр не применяется (решает Client.roleOf)
                assertTrue(c.getString("name"), allowed)
                continue
            }
            val got = ParvaneStore.isContentAllowedForMember(c.getJSONObject("perms"), c.getString("kind"), c.getBoolean("hasLink"))
            assertEquals(c.getString("name"), allowed, got)
        }
    }

    @Test
    fun contentKindsMatchRule() {
        val kinds = rules().getJSONObject("contentKinds")
        val media = kinds.getJSONArray("send_media")
        val noMedia = JSONObject("""{"send_media":false}""")
        for (i in 0 until media.length()) assertFalse(media.getString(i), ParvaneStore.isContentAllowedForMember(noMedia, media.getString(i), false))
        val st = kinds.getJSONArray("send_stickers_gifs")
        val noSt = JSONObject("""{"send_stickers_gifs":false}""")
        for (i in 0 until st.length()) assertFalse(ParvaneStore.isContentAllowedForMember(noSt, st.getString(i), false))
        assertTrue(ParvaneStore.isContentAllowedForMember(noSt, "photo", false))
    }

    @Test
    fun contentHasLinkDetectsWebpageAndEntities() {
        assertTrue(ParvaneStore.contentHasLink(JSONObject("""{"kind":"text","text":"x","webpage":{"url":"https://x"}}""")))
        assertTrue(ParvaneStore.contentHasLink(JSONObject("""{"kind":"text","entities":[{"type":"MessageEntityUrl","offset":0,"length":3}]}""")))
        assertTrue(ParvaneStore.contentHasLink(JSONObject("""{"kind":"text","entities":[{"type":"text_url"}]}""")))
        assertFalse(ParvaneStore.contentHasLink(JSONObject("""{"kind":"text","text":"plain","entities":[{"type":"MessageEntityBold"}]}""")))
        assertFalse(ParvaneStore.contentHasLink(null))
    }

    @Test
    fun permissionsRoundTrip() {
        val s = ParvaneStore()
        val wire = JSONObject("""{"send_messages":true,"send_media":false,"send_stickers_gifs":true,"send_polls":false,
            "embed_links":false,"invite_users":true,"pin_messages":true,"change_info":false}""")
        val back = ParvaneStore.permissionsToWire(s.chatPermissionsOf(wire))
        for (k in wire.keys()) assertEquals(k, wire.getBoolean(k), back.getBoolean(k))
        // «Send Messages» с экрана — только по canSendBasicMessages: снятый запрет медиа не гасит текст
        val p = s.chatPermissionsOf(JSONObject("""{"send_media":false}"""))
        assertTrue(p.canSendBasicMessages)
        assertTrue(ParvaneStore.permissionsToWire(p).getBoolean("send_messages"))
        assertFalse(ParvaneStore.permissionsToWire(p).getBoolean("send_media"))
    }

    @Test
    fun adminRightsRoundTrip() {
        val s = ParvaneStore()
        val wire = JSONObject("""{"change_info":true,"delete_messages":false,"ban_users":true,"invite_users":false,"pin_messages":true,"add_admins":false}""")
        val back = ParvaneStore.adminRightsToWire(s.adminRightsOf(wire))
        for (k in wire.keys()) assertEquals(k, wire.getBoolean(k), back.getBoolean(k))
        val rights = s.adminRightsOf(wire)
        assertTrue(rights.canRestrictMembers && !rights.canPromoteMembers && rights.canChangeInfo)
    }
}
