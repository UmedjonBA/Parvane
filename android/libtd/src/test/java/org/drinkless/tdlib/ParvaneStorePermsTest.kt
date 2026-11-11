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

    // spec 035 T136 (ENGINE-1): роль автора, права и вид содержимого решает движок (`groupContentHidden`), своей
    // формулы у шва нет — кейсы правила сверяются с движком, как web conformance.test.ts
    private fun wireOf(kind: String): JSONObject =
        if (kind == "audio") JSONObject().put("kind", "file").put("mime", "audio/mpeg") else JSONObject().put("kind", kind).put("text", "x")
    private fun hidden(perms: JSONObject, wire: JSONObject) = org.parvane.core.ParvaneProtocol.groupContentHidden(perms, "member", wire)
    private val allPerms = JSONObject("""{"send_messages":true,"send_media":true,"send_stickers_gifs":true,"send_polls":true,"embed_links":true}""")

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
            val wire = wireOf(c.getString("kind"))
            if (c.getBoolean("hasLink")) wire.put("webpage", JSONObject().put("url", "https://x"))
            assertEquals(c.getString("name"), allowed, !hidden(c.getJSONObject("perms"), wire))
        }
    }

    @Test
    fun contentKindsAreDecidedByEngine() {
        val kinds = rules().getJSONObject("contentKinds")
        val media = kinds.getJSONArray("send_media")
        val noMedia = JSONObject(allPerms.toString()).put("send_media", false)
        for (i in 0 until media.length()) {
            assertTrue(media.getString(i), hidden(noMedia, wireOf(media.getString(i))))
            assertFalse(media.getString(i), hidden(allPerms, wireOf(media.getString(i))))
        }
        val st = kinds.getJSONArray("send_stickers_gifs")
        val noSt = JSONObject(allPerms.toString()).put("send_stickers_gifs", false)
        for (i in 0 until st.length()) assertTrue(st.getString(i), hidden(noSt, wireOf(st.getString(i))))
        assertFalse(hidden(noSt, wireOf("photo")))
        // поле прав, которого нет в сведениях группы, — «разрешено»; без сведений о правах не скрывается ничего
        assertFalse(hidden(JSONObject("""{"send_media":true}"""), wireOf("photo")))
        assertFalse(org.parvane.core.ParvaneProtocol.groupContentHidden(null, "member", wireOf("photo")))
    }

    @Test
    fun linksInTextAreDecidedByEngine() {
        val noLinks = JSONObject(allPerms.toString()).put("embed_links", false)
        assertTrue(hidden(noLinks, JSONObject("""{"kind":"text","text":"x","webpage":{"url":"https://x"}}""")))
        assertFalse(hidden(noLinks, JSONObject("""{"kind":"text","text":"plain"}""")))
        assertFalse(hidden(allPerms, JSONObject("""{"kind":"text","text":"x","webpage":{"url":"https://x"}}""")))
    }

    @Test
    fun noOwnContentKindTables() {
        val src = listOf(File("src/main/java/org/drinkless/tdlib/ParvaneStore.kt"), File("libtd/src/main/java/org/drinkless/tdlib/ParvaneStore.kt"))
            .first { it.exists() }.readText()
        assertFalse(src.contains("MEDIA_KINDS"))
        assertFalse(src.contains("isContentAllowedForMember"))
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
